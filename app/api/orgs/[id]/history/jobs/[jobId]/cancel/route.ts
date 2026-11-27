import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { cancelJob, jobView, loadJob } from "@/lib/history/jobs";
import { batchClient, fail, noStore, requireAdmin } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * "Avbryt inläsningen" (admins). A batch: Anthropic is asked to stop; what Claude already read
 * is still saved when the batch has ended (it is paid for), without a goals proposal. If Claude
 * had already finished, nothing is cancelled: the results are saved and goals proposed. A direct
 * import: the meetings not yet started are skipped. → `{ job }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
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
    const outcome = await cancelJob(admin, job, batchClient());
    if (!outcome) return fail("not_running", 409, t("api.jobNotRunning"));
    // "ended": Claude had already finished; the results were saved instead (the view shows it).
    console.info(`history/job: cancel → ${outcome} (${job.mode})`);
    return NextResponse.json({ job: await jobView(admin, jobId) }, { headers: noStore });
  } catch (err) {
    console.error(`history/job: cancel: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 502, t("api.jobCancelFailed"));
  }
}
