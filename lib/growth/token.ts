import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

// The invite link's token (0067): "<invite id, 32 hex><HMAC, 22 base64url>", 54 characters of
// [0-9a-zA-Z_-] only, so it survives safeNextPath and the sign-in's `next` round trip. The HMAC
// covers the id AND the invited address: the token is bound to that address (the claim also
// requires a Google-confirmed sign-in with it, so a forwarded link gives nobody else access).
// Nothing secret is stored; the ledger row holds expiry and single use (claimed_at). The key is
// derived from TOKEN_ENC_KEY with its own label (like lib/email/token.ts).

const key = () => createHmac("sha256", getEnv().TOKEN_ENC_KEY).update("simon-says meeting invite v1").digest();
const sign = (id: string, email: string) => createHmac("sha256", key()).update(`${id}\u0000${email}`).digest().subarray(0, 16).toString("base64url");

const TOKEN = /^([0-9a-f]{32})([A-Za-z0-9_-]{22})$/;

export function inviteToken(inviteId: string, email: string): string {
  const hex = inviteId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("inviteToken: not an id");
  return `${hex}${sign(uuidOf(hex), email.trim().toLowerCase())}`;
}

const uuidOf = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** The invite id a well-formed token names (not yet checked against its address), or null. */
export function inviteIdOf(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const m = TOKEN.exec(token);
  return m ? uuidOf(m[1]) : null;
}

/** Is the token the one we made for this invite and address? */
export function checkInviteToken(token: string, inviteId: string, email: string | null): boolean {
  if (!email) return false;
  const m = TOKEN.exec(token);
  if (!m || uuidOf(m[1]) !== inviteId) return false;
  const want = Buffer.from(sign(inviteId, email.trim().toLowerCase()));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
