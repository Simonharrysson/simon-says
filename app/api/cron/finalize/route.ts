import { verifyCron } from "@/lib/cron";
import { finalizeSweep } from "@/lib/meetings/tick";

export const dynamic = "force-dynamic";
// Final passes of meetings nobody is connected to any more run inside this request.
export const maxDuration = 300;

/**
 * Vercel Cron, every 5 min (`Authorization: Bearer $CRON_SECRET`): close expired ElevenLabs
 * sessions, end meetings no tab is connected to (presence) and stuck ones, resume paused Docs, tick leftover segments.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const summary = await finalizeSweep();
  console.log(`cron finalize: ${JSON.stringify(summary)}`);
  return Response.json(summary);
}
