import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT, requestLocale } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { importOneSection } from "@/lib/history/import-one";
import { closeDirectJobIfFinished, jobView, loadJob } from "@/lib/history/jobs";
import { STALE_READING_MS } from "@/lib/history/progress";
import { fail, noStore, requireAdmin } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// One Doc read and ONE Claude call (one meeting); the extraction itself times out at 110 s.
export const maxDuration = 180;

/**
 * Reads ONE meeting of an import job (admins): the direct path's next meeting, or t("api.tryAgain")
 * on a meeting that failed (in a direct or a batch import; a retry is a normal call with the
 * server-side fallbacks, and counts toward the förening's 60 per 24 h). The Doc is read with the
 * caller's own grant: the import's read access when the job was picked in the folder browser
 * (the job stands in for the listing's tickets: it holds only Docs this förening's admin ticked),
 * else the sign-in grant. Errors that stop the rest (`google_auth_lost`, `rate_limited`, `spend`)
 * and Anthropic's 429/529 (`busy`, the item goes back to waiting) are told apart for the
 * browser's pool. → `{ job }` or `{ error, message, job }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string; itemId: string }> }) {
  const t = apiT(request);
  const { id, jobId, itemId } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const guard = await requireAdmin(id, t);
  if (!guard.ok) return guard.reply;
  const itemNo = Number(itemId);
  if (!isUuid(jobId) || !Number.isSafeInteger(itemNo) || itemNo < 1) return fail("not_found", 404, t("api.protocolNotFound"));
  const admin = supabaseAdmin();

  const job = await loadJob(admin, jobId).catch(() => null);
  if (!job || job.org_id !== id) return fail("not_found", 404, t("api.jobNotFound"));
  const { data: item, error } = await admin
    .from("history_import_items")
    .select("id, drive_file_id, section, sections, state, started_at, attempts")
    .eq("id", itemNo)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error || !item) return fail("not_found", 404, t("api.protocolNotFound"));

  const now = Date.now();
  const stale = item.state === "reading" && (!item.started_at || now - Date.parse(item.started_at) > STALE_READING_MS);
  const nextOfDirect = job.mode === "direct" && job.status === "running" && (item.state === "waiting" || stale);
  const retry = item.state === "failed" || (stale && job.mode === "direct");
  if (!nextOfDirect && !retry) return fail("not_runnable", 409, t("api.itemNotRunnable"));
  if (job.status === "canceling" || (job.mode === "batch" && job.status === "running")) return fail("not_runnable", 409, t("api.waitForBatch"));
  // The folder browser's read access is the admin's own: only the admin who picked these Docs
  // (the job stands in for their listing's tickets) may open them with it.
  if (job.via_listing && job.created_by !== guard.userId) {
    return fail("not_creator", 403, t("api.notCreator"));
  }

  // Take the row (from the state just read, so two tabs cannot both run it).
  const { data: taken } = await admin
    .from("history_import_items")
    .update({ state: "reading", reason: null, started_at: new Date(now).toISOString(), finished_at: null, attempts: (item.attempts as number) + 1 })
    .eq("id", itemNo)
    .eq("state", item.state)
    .select("id");
  if (!taken?.length) return fail("not_runnable", 409, t("api.itemNotRunnable"));

  const res = await importOneSection(guard.db, {
    userId: guard.userId,
    orgId: id,
    docId: item.drive_file_id as string,
    section: item.section as number,
    sections: item.sections as number,
    viaListing: job.via_listing,
  }, { locale: requestLocale(request) });
  const finishedAt = new Date().toISOString();
  if (res.ok) {
    await admin
      .from("history_import_items")
      .update({ state: "done", reason: null, protocol_id: res.protocolId, meeting_date: res.date, date_from: res.dateFrom, finished_at: finishedAt })
      .eq("id", itemNo);
  } else if (res.error === "busy") {
    // Not run at Anthropic: back in the queue, the browser waits and tries again.
    await admin.from("history_import_items").update({ state: item.state === "failed" ? "failed" : "waiting", reason: item.state === "failed" ? "error" : null, started_at: null }).eq("id", itemNo);
  } else {
    await admin.from("history_import_items").update({ state: "failed", reason: res.error.slice(0, 40), finished_at: finishedAt }).eq("id", itemNo);
  }
  if (job.mode === "direct") await closeDirectJobIfFinished(admin, jobId).catch((err: Error) => console.error(`history/item: close: ${err.message}`.slice(0, 200)));
  const view = await jobView(admin, jobId).catch(() => null);
  if (!res.ok) return NextResponse.json({ error: res.error, message: res.message, job: view }, { status: res.status, headers: noStore });
  return NextResponse.json({ job: view }, { headers: noStore });
}
