import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

/**
 * True when the request carries `Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends).
 * Constant-time compare. A present-but-wrong header is logged (never its value).
 */
export function verifyCron(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (header === null) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${getEnv().CRON_SECRET}`);
  const ok = got.length === want.length && timingSafeEqual(got, want);
  if (!ok) console.warn("cron: authorization header did not match CRON_SECRET");
  return ok;
}
