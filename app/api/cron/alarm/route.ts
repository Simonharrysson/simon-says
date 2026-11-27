import { sendDailySummary } from "@/lib/alarm";
import { verifyCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron, 06:00 UTC (`Authorization: Bearer $CRON_SECRET`): yesterday's summary email.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { summary, sent } = await sendDailySummary();
  console.log(`cron alarm: ${summary.day} usd=${summary.totalUsd.toFixed(2)} sent=${sent}`);
  // No retention cleanup here: usage records are kept (Simon, 2026-11-25; see docs/learnings.md).
  // The MCP server's audit is kept 90 days; expired OAuth rows go too (0060 mcp_cleanup).
  const { data: mcpDeleted, error } = await supabaseAdmin().rpc("mcp_cleanup");
  if (error) console.error(`cron alarm: mcp cleanup: ${error.message}`.slice(0, 200));
  else console.log(`cron alarm: mcp audit rows deleted=${mcpDeleted}`);
  return Response.json({ day: summary.day, totalUsd: summary.totalUsd, exceeded: summary.exceeded, sent });
}
