import { runBriefs } from "@/lib/brief/store";
import { verifyCron } from "@/lib/cron";

export const dynamic = "force-dynamic";
// One user can take ~35 s at worst (calendar, Claude, mail), so the budget stops starting new
// users well before this.
export const maxDuration = 60;

/**
 * Vercel Cron, every 5 min (`Authorization: Bearer $CRON_SECRET`): Inför möten (0059). For every
 * account with a calendar grant, a short mail before each meeting starting within 15 minutes that
 * is a förening's / Företag's or a Företag customer's, at most once per user and meeting (the
 * sent-log). Logs counts only.
 */
export async function GET(request: Request) {
  if (!verifyCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await runBriefs({ budgetMs: 25_000 });
    console.log(`cron brief: ${JSON.stringify(result)}`);
    return Response.json(result);
  } catch (err) {
    console.error(`cron brief: ${(err as Error).message}`.slice(0, 200));
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
