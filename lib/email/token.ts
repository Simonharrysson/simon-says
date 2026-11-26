import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { cleanEmail } from "@/lib/people/board";
import type { EmailCategory } from "./categories";

// The signed link in every user-facing mail: "<base64url(address)>.<hmac>". It names the address
// the mail went to and nothing else, so whoever has the mail can change that address's choices
// without logging in (and only that address's). It does not expire: an unsubscribe link in an old
// mail must keep working. The key is derived from TOKEN_ENC_KEY with its own label, so no new env
// var is needed and it never equals another token's key. Rotating TOKEN_ENC_KEY invalidates every
// link in mails already sent (people then use Konto or a newer mail's link): rotate with that in mind.

const key = () => createHmac("sha256", getEnv().TOKEN_ENC_KEY).update("simon-says email prefs v1").digest();
const sign = (email: string) => createHmac("sha256", key()).update(email).digest("base64url");

export function emailPrefsToken(email: string): string {
  const clean = cleanEmail(email);
  if (!clean) throw new Error("emailPrefsToken: not an e-mail address");
  return `${Buffer.from(clean, "utf8").toString("base64url")}.${sign(clean)}`;
}

/** The address a token was made for, or null when it is malformed or not ours. */
export function checkEmailPrefsToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const m = /^([A-Za-z0-9_-]{4,400})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const email = cleanEmail(Buffer.from(m[1], "base64url").toString("utf8"));
  if (!email) return null;
  const want = Buffer.from(sign(email));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? email : null;
}

/** The page in the mail's footer: every category for that address, no login. */
export function emailPrefsUrl(email: string, category?: EmailCategory, appUrl = getEnv().APP_URL): string {
  const url = new URL("/mejl", appUrl);
  url.searchParams.set("t", emailPrefsToken(email));
  if (category) url.searchParams.set("k", category);
  return url.toString();
}

/** The one-click endpoint (RFC 8058): a POST turns this category off for that address. */
export function oneClickUnsubscribeUrl(email: string, category: EmailCategory, appUrl = getEnv().APP_URL): string {
  const url = new URL("/api/mejl/avsluta", appUrl);
  url.searchParams.set("t", emailPrefsToken(email));
  url.searchParams.set("k", category);
  return url.toString();
}

/**
 * Headers for a user-facing mail (MailMessage.headers on the meeting-summary branch): mail apps
 * show "Avsluta prenumeration" and POST to the one-click endpoint; the page is the fallback.
 */
export function listUnsubscribeHeaders(email: string, category: EmailCategory, appUrl = getEnv().APP_URL): Record<string, string> {
  return {
    "List-Unsubscribe": `<${oneClickUnsubscribeUrl(email, category, appUrl)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
