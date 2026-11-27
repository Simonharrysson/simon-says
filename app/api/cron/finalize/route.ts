import { verifyCron } from "@/lib/cron";
import { deleteExpiredImportTokens } from "@/lib/google/client";
import { drainForetagQueues } from "@/lib/foretag/reconcile";
import { finalizeSweep } from "@/lib/meetings/tick";

export const dynamic = "force-dynamic";
// Final passes of meetings nobody is connected to any more run inside this request.
export const maxDuration = 300;

/**
 * Vercel Cron, every 5 min (`Authorization: Bearer $CRON_SECRET`): close expired ElevenLabs
 * sessions, end meetings no tab is connected to (presence) and stuck ones, resume paused Docs, tick leftover segments; delete import read grants older than 24 h;
 * reconcile Företag companies changed outside the app's actions and revoke a deleted account's Doc access (0053).
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const summary = await finalizeSweep();
  console.log(`cron finalize: ${JSON.stringify(summary)}`);
  // The protocol import's read access lives 24 h (0034); never let this break the sweep.
  await deleteExpiredImportTokens().then(
    (n) => n && console.log(`cron finalize: ${n} expired import grants deleted`),
    (err) => console.error(`cron finalize: import grants: ${(err as Error).message}`.slice(0, 200)),
  );
  // Företag (0053): never let this break the sweep either.
  await drainForetagQueues().then(
    (n) => (n.orgs || n.revocations) && console.log(`cron finalize: foretag ${JSON.stringify(n)}`),
    (err) => console.error(`cron finalize: foretag queues: ${(err as Error).message}`.slice(0, 200)),
  );
  return Response.json(summary);
}
