import { verifyCron } from "@/lib/cron";
import { advanceJob, failStaleSubmits, openBatchJobIds } from "@/lib/history/jobs";
import { batchClient } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// The goals digest of a finished batch import can take ~4 minutes.
export const maxDuration = 300;

/** Stop starting new steps after this long. */
const BUDGET_MS = 60_000;
/** A digest (up to ~280 s) is only started this early in a run, so it fits maxDuration. */
const DIGEST_START_MS = 10_000;

/**
 * Vercel Cron, every 5 min (`Authorization: Bearer $CRON_SECRET`): moves each open batch import
 * one step (poll Anthropic, save the results of an ended batch, or run its goals digest once:
 * only at the start of a run, so it fits the time limit), fails batch jobs whose submit never
 * finished, and removes finished imports older than 7 days (0036). Also sweeps hung invite e-mails
 * (0038). Logs only counts and step names.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const started = Date.now();
  const steps: string[] = [];
  try {
    const stale = await failStaleSubmits(db);
    if (stale) steps.push(`stale:${stale}`);
    for (const jobId of await openBatchJobIds(db)) {
      if (Date.now() - started > BUDGET_MS) break;
      const digest = Date.now() - started < DIGEST_START_MS;
      steps.push(await advanceJob(db, jobId, { client: batchClient(), digest, force: true }).catch((err: Error) => {
        console.error(`cron import: ${err.message}`.slice(0, 200));
        return "error";
      }));
    }
  } catch (err) {
    console.error(`cron import: ${(err as Error).message}`.slice(0, 200));
  }
  const { data: removed, error } = await db.rpc("delete_old_history_import_jobs");
  if (error) console.error(`cron import: cleanup: ${error.message}`.slice(0, 200));
  // Invite e-mails left `sending` by a function that died (0038) become `uncertain`, so the admin
  // can try again (Resend's Idempotency-Key keeps that from sending twice). Counts only.
  const { data: swept, error: sweepError } = await db.rpc("sweep_stale_invite_sends");
  if (sweepError) console.error(`cron import: invite sweep: ${sweepError.message}`.slice(0, 200));
  else if (swept) steps.push(`invites:${swept}`);
  console.log(`cron import: ${JSON.stringify({ steps, removed: removed ?? 0 })}`);
  return Response.json({ steps, removed: removed ?? 0 });
}
