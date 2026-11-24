import { verifyCron } from "@/lib/cron";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

// GET /api/health -> { ok: true } when the server env is valid.
// Also the target of the dummy */5 cron (Task 1 early check): Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`, and we log a fixed marker so firing is visible in logs.
export async function GET(request: Request) {
  try {
    getEnv();
  } catch (error) {
    console.error("health: env invalid", error instanceof Error ? error.message : error);
    return Response.json({ ok: false }, { status: 500 });
  }
  if (verifyCron(request)) console.log("health: cron-tick");
  return Response.json({ ok: true });
}
