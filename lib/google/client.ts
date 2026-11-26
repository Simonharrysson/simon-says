import "server-only";
import { OAuth2Client } from "google-auth-library";
import { decrypt, encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GOOGLE_SCOPES, hasDriveReadonly } from "./scopes";

/** The user's Google grant is gone (never stored, revoked, or expired): they must sign in again. */
export class GoogleAuthLostError extends Error {
  constructor(
    readonly userId: string,
    reason: string,
  ) {
    super(`Google authorization lost for user ${userId}: ${reason}`);
    this.name = "GoogleAuthLostError";
  }
}

/** Store (or replace) the user's refresh token, encrypted. */
export async function storeGoogleToken(userId: string, refreshToken: string, scope: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("google_tokens")
    .upsert({
      user_id: userId,
      refresh_token_enc: encrypt(refreshToken),
      scope,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`storeGoogleToken: ${error.message}`);
}

/** True if a token row exists for the user. */
export async function hasGoogleToken(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("google_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`hasGoogleToken: ${error.message}`);
  return data !== null;
}

/**
 * The scopes of the user's stored grant (as Google reported them when it was stored), or null
 * when no token is stored. drive.readonly is in it only after the admin's incremental consent
 * for the protocol import; a later plain sign-in replaces the token with a drive.file-only one.
 */
export async function storedGoogleScope(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("google_tokens")
    .select("scope")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`storedGoogleScope: ${error.message}`);
  return (data?.scope as string | undefined) ?? null;
}

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  return (
    e?.response?.data?.error === "invalid_grant" ||
    (typeof e?.message === "string" && e.message.includes("invalid_grant"))
  );
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * An access token for only the sign-in scopes (drive.file), from a refresh token that also holds
 * drive.readonly: Google lets a refresh ask for a subset of the granted scopes. Null when Google
 * refuses the narrowing (the caller then falls back to the full token); invalid_grant throws.
 */
async function narrowAccessToken(userId: string, refreshToken: string): Promise<{ access_token: string; expiry_date: number } | null> {
  const env = getEnv();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      scope: GOOGLE_SCOPES.join(" "),
    }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (body?.error === "invalid_grant") throw new GoogleAuthLostError(userId, "invalid_grant");
  if (!res.ok || typeof body?.access_token !== "string") {
    console.warn(`google: narrowing the token failed (${res.status} ${String(body?.error ?? "")})`.slice(0, 200));
    return null;
  }
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { access_token: body.access_token, expiry_date: Date.now() + seconds * 1000 };
}

/**
 * An OAuth2Client for the user, with a fresh access token already fetched (so a dead
 * refresh token surfaces here, not halfway through a Docs write).
 * Throws GoogleAuthLostError on a missing token or `invalid_grant`.
 *
 * An admin who gave drive.readonly for the protocol import has one refresh token for both
 * scopes. Everything except that import (`driveReadonly: true`) gets access tokens narrowed to
 * the sign-in scopes, so the rest of the app (agenda candidates, folder checks, the Picker's
 * token) sees exactly what a drive.file grant sees and never offers a file it cannot write.
 */
export async function getGoogleAuth(userId: string, opts: { driveReadonly?: boolean } = {}): Promise<OAuth2Client> {
  const { data, error } = await supabaseAdmin()
    .from("google_tokens")
    .select("refresh_token_enc, scope")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleAuth: ${error.message}`);
  if (!data) throw new GoogleAuthLostError(userId, "no stored refresh token");

  const env = getEnv();
  const client = new OAuth2Client({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  const refreshToken = decrypt(data.refresh_token_enc as string);
  if (hasDriveReadonly(data.scope as string | undefined) && !opts.driveReadonly) {
    const narrow = await narrowAccessToken(userId, refreshToken);
    if (narrow) {
      // No refresh token on this client: when the access token expires, it narrows again.
      client.refreshHandler = async () => {
        const next = await narrowAccessToken(userId, refreshToken);
        if (!next) throw new Error("google: narrowing the token failed");
        return next;
      };
      client.setCredentials(narrow);
      return client;
    }
  }
  client.setCredentials({ refresh_token: refreshToken });
  try {
    await client.getAccessToken();
  } catch (err) {
    if (isInvalidGrant(err)) throw new GoogleAuthLostError(userId, "invalid_grant");
    throw err;
  }
  return client;
}
