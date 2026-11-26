import { createHmac, timingSafeEqual } from "node:crypto";

// The one-click unsubscribe link in a summary e-mail: proves "this link was mailed to this person"
// and opens nothing but their own unsubscribe. HMAC-SHA256 under a key derived from TOKEN_ENC_KEY
// with its own label (like presence-token.ts). No expiry: an old e-mail's link must keep working.
// Rotating TOKEN_ENC_KEY invalidates every unsubscribe link already mailed (the page then says the
// link doesn't work; the person can still ask an admin or mail us). Mention it when rotating.

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function sign(key: Buffer, body: string): string {
  const k = createHmac("sha256", key).update("simon-says summary-unsubscribe v1").digest();
  return b64(createHmac("sha256", k).update(body).digest());
}

export function issueUnsubscribeToken(key: Buffer, personId: string): string {
  const body = b64(JSON.stringify({ p: personId }));
  return `${body}.${sign(key, body)}`;
}

/** The person the token was issued for, when it is genuine. */
export function verifyUnsubscribeToken(key: Buffer, token: string | null | undefined): string | null {
  if (!token || token.length > 300) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { p?: unknown };
    return typeof p.p === "string" && /^[0-9a-f-]{36}$/i.test(p.p) ? p.p : null;
  } catch {
    return null;
  }
}
