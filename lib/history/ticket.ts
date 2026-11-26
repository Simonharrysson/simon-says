import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

// Import tickets: the Drive listing signs each file it shows to an admin (user, förening, file,
// expiry). The estimate and import routes use the admin's drive.readonly grant ONLY for a file
// with a valid ticket, so the read access opens nothing but files the admin was shown and
// ticked (the /integritet promise holds for the API too). Nothing is stored server-side.

/** A listing stays usable this long (a 60-protocol import takes well under an hour). */
export const TICKET_SECONDS = 3 * 3600;

const key = () => createHmac("sha256", getEnv().TOKEN_ENC_KEY).update("simon-says import ticket v1").digest();
const sign = (userId: string, orgId: string, fileId: string, exp: number) =>
  createHmac("sha256", key()).update(`${userId}|${orgId}|${fileId}|${exp}`).digest("base64url");

export function fileTicket(userId: string, orgId: string, fileId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + TICKET_SECONDS;
  return `${exp}.${sign(userId, orgId, fileId, exp)}`;
}

export function checkTicket(ticket: unknown, userId: string, orgId: string, fileId: string, nowMs = Date.now()): boolean {
  if (typeof ticket !== "string" || ticket.length > 100) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < nowMs) return false;
  const want = Buffer.from(sign(userId, orgId, fileId, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
