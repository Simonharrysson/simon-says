import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { advanceJob, jobView, loadJob } from "@/lib/history/jobs";
import { batchClient, fail, noStore, requireAdmin } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Polling a batch is one Anthropic request; when it has ended, saving its results is DB writes
// only (the goals digest is left to the cron).
export const maxDuration = 120;

/**
 * The import's state for the progress view (admins of the förening). For a running batch it
 * first polls Anthropic (at most every 20 s, shared with the cron) and, once the batch has
 * ended, saves the results, so the admin need not wait for the next cron run. → `{ job }`.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const t = apiT(request);
  const { id, jobId } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const guard = await requireAdmin(id, t);
  if (!guard.ok) return guard.reply;
  if (!isUuid(jobId)) return fail("not_found", 404, t("api.jobNotFound"));
  const admin = supabaseAdmin();
  try {
    const job = await loadJob(admin, jobId);
    if (!job || job.org_id !== id) return fail("not_found", 404, t("api.jobNotFound"));
    if (job.mode === "batch" && (job.status === "running" || job.status === "canceling")) {
      await advanceJob(admin, jobId, { client: batchClient() }).catch((err: Error) => console.error(`history/job: advance: ${err.message}`.slice(0, 200)));
    }
    return NextResponse.json({ job: await jobView(admin, jobId) }, { headers: noStore });
  } catch (err) {
    console.error(`history/job: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
}
