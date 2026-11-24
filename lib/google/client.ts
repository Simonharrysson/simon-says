import "server-only";
import { OAuth2Client } from "google-auth-library";
import { decrypt, encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";

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

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  return (
    e?.response?.data?.error === "invalid_grant" ||
    (typeof e?.message === "string" && e.message.includes("invalid_grant"))
  );
}

/**
 * An OAuth2Client for the user, with a fresh access token already fetched (so a dead
 * refresh token surfaces here, not halfway through a Docs write).
 * Throws GoogleAuthLostError on a missing token or `invalid_grant`.
 */
export async function getGoogleAuth(userId: string): Promise<OAuth2Client> {
  const { data, error } = await supabaseAdmin()
    .from("google_tokens")
    .select("refresh_token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleAuth: ${error.message}`);
  if (!data) throw new GoogleAuthLostError(userId, "no stored refresh token");

  const env = getEnv();
  const client = new OAuth2Client({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  client.setCredentials({ refresh_token: decrypt(data.refresh_token_enc as string) });
  try {
    await client.getAccessToken();
  } catch (err) {
    if (isInvalidGrant(err)) throw new GoogleAuthLostError(userId, "invalid_grant");
    throw err;
  }
  return client;
}
