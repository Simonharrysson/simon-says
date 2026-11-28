import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { decrypt, encrypt } from "@/lib/crypto";
import { e2eGoogleRoot } from "@/lib/e2e/guard";
import { getEnv } from "@/lib/env";
import { appOrigin } from "@/lib/origin";
import { DRIVE_ACCOUNT_SCOPES, hasDriveFile } from "./scopes";

// "Använd ett annat Google-konto" (0070): Google's own OAuth code flow, NOT Supabase's sign-in
// (that would switch the session to the other account). The start (a server action, admins only)
// seals a state into an httpOnly cookie bound to the signed-in user and the förening; the callback
// (app/api/google/drive-account/callback) accepts the answer only for that same user, still an
// admin, within ten minutes, with the matching `state` and the PKCE verifier from the cookie.

export const STATE_COOKIE = "ss_drive_account";
/** The cookie is sent only to the callback. */
export const STATE_COOKIE_PATH = "/api/google/drive-account";
export const STATE_TTL_SECONDS = 600;

/** Where the admin came from (and returns to). */
export type DriveAccountReturn = "kom-igang" | "installningar";

export function returnPath(orgId: string, from: DriveAccountReturn): string {
  return from === "kom-igang" ? `/orgs/${orgId}/kom-igang?steg=3` : `/orgs/${orgId}?flik=installningar&del=moten`;
}

export const callbackUrl = () => `${appOrigin()}/api/google/drive-account/callback`;

interface SealedState {
  /** The `state` sent to Google. */
  n: string;
  /** The signed-in user who started it. */
  u: string;
  /** The förening. */
  o: string;
  /** PKCE code verifier. */
  v: string;
  r: DriveAccountReturn;
  /** Expiry, epoch ms. */
  e: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** A new flow: the cookie value (encrypted, AES-GCM authenticates it) and Google's authorize URL. */
export function startDriveAccountFlow(input: { userId: string; orgId: string; from: DriveAccountReturn; loginHint?: string | null; now?: number }): {
  cookie: string;
  url: string;
} {
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const sealed: SealedState = { n: nonce, u: input.userId, o: input.orgId, v: verifier, r: input.from, e: (input.now ?? Date.now()) + STATE_TTL_SECONDS * 1000 };
  return { cookie: encrypt(JSON.stringify(sealed)), url: authorizeUrl({ state: nonce, verifier, loginHint: input.loginHint ?? null }) };
}

/** Google's consent screen: pick an account, drive.file only, a refresh token every time. */
export function authorizeUrl(input: { state: string; verifier: string; loginHint: string | null }): string {
  const fake = e2eGoogleRoot();
  const url = new URL(fake ? `${fake}o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth");
  const challenge = b64url(createHash("sha256").update(input.verifier).digest());
  const params: Record<string, string> = {
    client_id: getEnv().GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: DRIVE_ACCOUNT_SCOPES.join(" "),
    access_type: "offline",
    // select_account: the förening's account, not the one the browser is signed in with.
    // consent: Google returns a refresh token only on a consent.
    prompt: "select_account consent",
    state: input.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export type StateCheck = { ok: true; orgId: string; verifier: string; from: DriveAccountReturn } | { ok: false; reason: "missing" | "invalid" | "expired" | "state" | "user" };

/** The callback's checks of the cookie against the answer and the session. */
export function checkDriveAccountState(cookie: string | undefined, state: string | null, userId: string | null, now = Date.now()): StateCheck {
  if (!cookie) return { ok: false, reason: "missing" };
  let s: SealedState;
  try {
    s = JSON.parse(decrypt(cookie)) as SealedState;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof s?.n !== "string" || typeof s.u !== "string" || typeof s.o !== "string" || typeof s.v !== "string" || typeof s.e !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (s.e < now) return { ok: false, reason: "expired" };
  const a = Buffer.from(state ?? "");
  const b = Buffer.from(s.n);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "state" };
  if (!userId || userId !== s.u) return { ok: false, reason: "user" };
  return { ok: true, orgId: s.o, verifier: s.v, from: s.r === "kom-igang" ? "kom-igang" : "installningar" };
}

export interface ConnectedAccount {
  refreshToken: string;
  scope: string;
  sub: string;
  email: string;
}

export type ExchangeResult = { ok: true; account: ConnectedAccount } | { ok: false; reason: "no_drive" | "no_refresh" | "identity" };

/**
 * Exchange the code (with the PKCE verifier) and ask Google whose token it is: tokeninfo answers
 * for our own client only (`aud`), with the account's stable id and verified address and the
 * scopes really granted. drive.file unticked is `no_drive`; nothing is stored then.
 */
export async function exchangeDriveAccountCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<ExchangeResult> {
  const env = getEnv();
  const fake = e2eGoogleRoot();
  const client = new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: callbackUrl(),
    ...(fake ? { endpoints: { oauth2TokenUrl: `${fake}token` } } : {}),
  });
  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  if (!tokens.access_token) return { ok: false, reason: "identity" };
  const res = await fetchImpl(fake ? `${fake}tokeninfo` : "https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: tokens.access_token }),
  });
  if (!res.ok) return { ok: false, reason: "identity" };
  const info = (await res.json()) as { aud?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown; scope?: unknown };
  const verified = info.email_verified === true || info.email_verified === "true";
  if (info.aud !== env.GOOGLE_CLIENT_ID || typeof info.sub !== "string" || !info.sub || typeof info.email !== "string" || !verified) {
    return { ok: false, reason: "identity" };
  }
  const scope = typeof info.scope === "string" ? info.scope : "";
  if (!hasDriveFile(scope)) return { ok: false, reason: "no_drive" };
  if (!tokens.refresh_token) return { ok: false, reason: "no_refresh" };
  return { ok: true, account: { refreshToken: tokens.refresh_token, scope, sub: info.sub, email: info.email.toLowerCase() } };
}
