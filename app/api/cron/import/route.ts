import { verifyCron } from "@/lib/cron";
import { advanceJob, openBatchJobIds } from "@/lib/history/jobs";
import { batchClient } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// The goals digest of a finished batch import can take ~4 minutes.
export const maxDuration = 300;

/** Stop starting new steps after this long, so a digest started here still fits maxDuration. */
const BUDGET_MS = 60_000;

/**
 * Vercel Cron, every 5 min (`Authorization: Bearer $CRON_SECRET`): moves each open batch import
 * one step (poll Anthropic, save the results of an ended batch, or run its goals digest once),
 * and removes finished imports older than 7 days (0036). Logs only counts and step names.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const started = Date.now();
  const steps: string[] = [];
  try {
    for (const jobId of await openBatchJobIds(db)) {
      if (Date.now() - started > BUDGET_MS) break;
      steps.push(await advanceJob(db, jobId, { client: batchClient(), digest: true, force: true }).catch((err: Error) => {
        console.error(`cron import: ${err.message}`.slice(0, 200));
        return "error";
      }));
    }
  } catch (err) {
    console.error(`cron import: ${(err as Error).message}`.slice(0, 200));
  }
  const { data: removed, error } = await db.rpc("delete_old_history_import_jobs");
  if (error) console.error(`cron import: cleanup: ${error.message}`.slice(0, 200));
  console.log(`cron import: ${JSON.stringify({ steps, removed: removed ?? 0 })}`);
  return Response.json({ steps, removed: removed ?? 0 });
}
