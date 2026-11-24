import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

function isCron(request: Request, secret: string): boolean {
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

// GET /api/health -> { ok: true } when the server env is valid.
// Also the target of the dummy */5 cron (Task 1 early check): Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`, and we log a fixed marker so firing is visible in logs.
export async function GET(request: Request) {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    console.error("health: env invalid", error instanceof Error ? error.message : error);
    return Response.json({ ok: false }, { status: 500 });
  }
  if (isCron(request, env.CRON_SECRET)) console.log("health: cron-tick");
  return Response.json({ ok: true });
}
