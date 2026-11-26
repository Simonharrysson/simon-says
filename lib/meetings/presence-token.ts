import { createHmac, timingSafeEqual } from "node:crypto";

// A meeting-scoped presence credential (review I2). The token route hands it to the tab that
// runs the meeting; the heartbeat accepts it when the sign-in cookie is gone, so a tab that is
// still alive keeps the meeting live (presence) while the user signs in again. It only proves
// "this member's tab for this meeting is alive": the heartbeat route re-checks membership and
// it opens nothing else. HMAC-SHA256 under a key derived from TOKEN_ENC_KEY (own label).

/** Longer than the 4 h meeting cap; every new ElevenLabs session issues a fresh one. */
export const PRESENCE_TOKEN_TTL_SEC = 5 * 3600;
export { PRESENCE_TOKEN_HEADER } from "./presence";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function sign(key: Buffer, body: string): string {
  const k = createHmac("sha256", key).update("simon-says presence-token v1").digest();
  return b64(createHmac("sha256", k).update(body).digest());
}

export function issuePresenceToken(key: Buffer, meetingId: string, userId: string, nowMs: number): string {
  const body = b64(JSON.stringify({ m: meetingId, u: userId, e: Math.floor(nowMs / 1000) + PRESENCE_TOKEN_TTL_SEC }));
  return `${body}.${sign(key, body)}`;
}

/** The member the token was issued to, when it is genuine, unexpired and for this meeting. */
export function verifyPresenceToken(key: Buffer, token: string | null | undefined, meetingId: string, nowMs: number): string | null {
  if (!token || token.length > 600) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { m?: unknown; u?: unknown; e?: unknown };
    if (p.m !== meetingId || typeof p.u !== "string" || typeof p.e !== "number") return null;
    if (p.e * 1000 < nowMs) return null;
    return p.u;
  } catch {
    return null;
  }
}
