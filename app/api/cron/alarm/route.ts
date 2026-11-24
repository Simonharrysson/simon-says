import { sendDailySummary } from "@/lib/alarm";
import { verifyCron } from "@/lib/cron";

export const dynamic = "force-dynamic";

/** Vercel Cron, 06:00 UTC (`Authorization: Bearer $CRON_SECRET`): yesterday's summary email. */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { summary, sent } = await sendDailySummary();
  console.log(`cron alarm: ${summary.day} usd=${summary.totalUsd.toFixed(2)} sent=${sent}`);
  return Response.json({ day: summary.day, totalUsd: summary.totalUsd, exceeded: summary.exceeded, sent });
}
