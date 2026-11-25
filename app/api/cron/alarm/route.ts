import { sendDailySummary } from "@/lib/alarm";
import { verifyCron } from "@/lib/cron";
import { cleanupRetention } from "@/lib/retention";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron, 06:00 UTC (`Authorization: Bearer $CRON_SECRET`): yesterday's summary email, then
 * the 24-month retention cleanup (/integritet). A failing cleanup never blocks the email, and
 * is retried by tomorrow's run.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { summary, sent } = await sendDailySummary();
  console.log(`cron alarm: ${summary.day} usd=${summary.totalUsd.toFixed(2)} sent=${sent}`);
  let retention: { usageDailyDeleted: number; orgCreationsDeleted: number } | { error: string };
  try {
    retention = await cleanupRetention();
    console.log(
      `cron retention: usage_daily=${retention.usageDailyDeleted} org_creations=${retention.orgCreationsDeleted}`,
    );
  } catch (e) {
    console.error("cron retention failed:", e instanceof Error ? e.message : e);
    retention = { error: "failed" };
  }
  return Response.json({ day: summary.day, totalUsd: summary.totalUsd, exceeded: summary.exceeded, sent, retention });
}
