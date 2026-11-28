import "server-only";
import { OAuth2Client } from "google-auth-library";
import { decrypt, encrypt } from "@/lib/crypto";
import { e2eGoogleRoot } from "@/lib/e2e/guard";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hasCalendarReadonly, hasDriveReadonly } from "./scopes";

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
 *
 * This is the sign-in token. Google may report earlier grants (drive.readonly from an import
 * consent) on a later plain sign-in; the token is still used as before; it still has drive.file.
 * The rule lives in our code: only the import's routes list or read files Simon Says did not
 * create or get picked, and they use the separate import token (getImportGoogleAuth).
 */
export async function getGoogleAuth(userId: string): Promise<OAuth2Client> {
  const { data, error } = await supabaseAdmin()
    .from("google_tokens")
    .select("refresh_token_enc, scope")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getGoogleAuth: ${error.message}`);
  if (!data) throw new GoogleAuthLostError(userId, "no stored refresh token");
  if (hasDriveReadonly(data.scope as string | undefined) && !loggedWide.has(userId)) {
    loggedWide.add(userId);
    console.info(`google: sign-in grant of ${userId} includes drive.readonly (used as drive.file)`);
  }
  return clientFor(userId, decrypt(data.refresh_token_enc as string));
}

const loggedWide = new Set<string>();

/** An OAuth2Client for a stored refresh token (fresh access token fetched); `label` names it in errors. */
export const clientForRefreshToken = (label: string, refreshToken: string) => clientFor(label, refreshToken);

async function clientFor(userId: string, refreshToken: string): Promise<OAuth2Client> {
  const env = getEnv();
  // The e2e test mode refreshes against the fake Google server (lib/e2e/guard.ts).
  const fake = e2eGoogleRoot();
  const client = new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    ...(fake ? { endpoints: { oauth2TokenUrl: `${fake}token` } } : {}),
  });
  client.setCredentials({ refresh_token: refreshToken });
  try {
    await client.getAccessToken();
  } catch (err) {
    if (isInvalidGrant(err)) throw new GoogleAuthLostError(userId, "invalid_grant");
    throw err;
  }
  return client;
}

// ---------------------------------------------------------------------------------------------
// The protocol import's read access (drive.readonly, incremental consent). Its refresh token is
// kept apart from the sign-in token in google_import_tokens (0034), used only by the import's
// routes, and for 24 hours at most. The sign-in token keeps its own scopes (Google never widens
// an issued refresh token), so nothing else ever runs with drive.readonly.

/** How long the import's read access is kept. */
export const IMPORT_TOKEN_HOURS = 24;

/** The admin has no (live) read access for the import: ask for it again. */
export class DriveAccessMissingError extends Error {
  constructor(readonly userId: string) {
    super(`no drive.readonly import grant for user ${userId}`);
    this.name = "DriveAccessMissingError";
  }
}

const importCutoff = () => new Date(Date.now() - IMPORT_TOKEN_HOURS * 3600_000).toISOString();

export async function storeImportToken(userId: string, refreshToken: string, scope: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("google_import_tokens")
    .upsert({ user_id: userId, refresh_token_enc: encrypt(refreshToken), scope, created_at: new Date().toISOString() });
  if (error) throw new Error(`storeImportToken: ${error.message}`);
}

/**
 * "Ta bort läsåtkomst": deletes OUR copy only. Not revoked at Google: revoking any token of a
 * grant revokes the user's whole grant to the app, sign-in token (drive.file) included.
 */
export async function deleteImportToken(userId: string): Promise<void> {
  const { error } = await supabaseAdmin().from("google_import_tokens").delete().eq("user_id", userId);
  if (error) throw new Error(`deleteImportToken: ${error.message}`);
}

/** Cron: removes import tokens older than 24 h. Returns how many. */
export async function deleteExpiredImportTokens(): Promise<number> {
  const { data, error } = await supabaseAdmin().from("google_import_tokens").delete().lt("created_at", importCutoff()).select("user_id");
  if (error) throw new Error(`deleteExpiredImportTokens: ${error.message}`);
  return (data ?? []).length;
}

async function importRow(userId: string): Promise<{ refresh_token_enc: string; scope: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from("google_import_tokens")
    .select("refresh_token_enc, scope")
    .eq("user_id", userId)
    .gt("created_at", importCutoff())
    .maybeSingle();
  if (error) throw new Error(`importRow: ${error.message}`);
  const row = data as { refresh_token_enc: string; scope: string } | null;
  return row && hasDriveReadonly(row.scope) ? row : null;
}

/** True when the user has live read access for the import (stored, under 24 h, drive.readonly). */
export async function hasImportAccess(userId: string): Promise<boolean> {
  return (await importRow(userId)) !== null;
}

/**
 * The import's client (drive.readonly). Only for the import's routes. A missing, expired or
 * revoked grant is DriveAccessMissingError (a revoked one is deleted too).
 */
export async function getImportGoogleAuth(userId: string): Promise<OAuth2Client> {
  const row = await importRow(userId);
  if (!row) throw new DriveAccessMissingError(userId);
  try {
    return await clientFor(userId, decrypt(row.refresh_token_enc));
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      await deleteImportToken(userId).catch(() => undefined);
      throw new DriveAccessMissingError(userId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// "Koppla kalender" (calendar.readonly, its own incremental consent, todo #14). The refresh token
// is kept apart in google_calendar_tokens (0046) and used only to read calendars: the förening
// page's upcoming meetings, the admin's calendar choice and the event a meeting matches at start.
// "Koppla från" deletes our copy.

/** The user has no (live) calendar grant: "Koppla kalender" again. */
export class CalendarAccessMissingError extends Error {
  constructor(readonly userId: string) {
    super(`no calendar.readonly grant for user ${userId}`);
    this.name = "CalendarAccessMissingError";
  }
}

export async function storeCalendarToken(userId: string, refreshToken: string, scope: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("google_calendar_tokens")
    .upsert({ user_id: userId, refresh_token_enc: encrypt(refreshToken), scope, created_at: new Date().toISOString() });
  if (error) throw new Error(`storeCalendarToken: ${error.message}`);
}

/**
 * "Koppla från": deletes OUR copy only. Not revoked at Google (revoking any token of a grant
 * revokes the user's whole grant to the app, the sign-in token included); the user can remove the
 * access in their Google account.
 */
export async function deleteCalendarToken(userId: string): Promise<void> {
  const { error } = await supabaseAdmin().from("google_calendar_tokens").delete().eq("user_id", userId);
  if (error) throw new Error(`deleteCalendarToken: ${error.message}`);
}

async function calendarRow(userId: string): Promise<{ refresh_token_enc: string; scope: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from("google_calendar_tokens")
    .select("refresh_token_enc, scope")
    .eq("user_id", userId)
    .maybeSingle();
  // A database without 0046 (deploy order): nobody is connected.
  if (error && (error.code === "42P01" || error.code === "PGRST205")) return null;
  if (error) throw new Error(`calendarRow: ${error.message}`);
  const row = data as { refresh_token_enc: string; scope: string } | null;
  return row && hasCalendarReadonly(row.scope) ? row : null;
}

/** True when the user has connected a calendar (stored, calendar.readonly). */
export async function hasCalendarAccess(userId: string): Promise<boolean> {
  return (await calendarRow(userId)) !== null;
}

/**
 * The calendar client (calendar.readonly). A missing or revoked grant is
 * CalendarAccessMissingError (a revoked one is deleted too).
 */
export async function getCalendarGoogleAuth(userId: string): Promise<OAuth2Client> {
  const row = await calendarRow(userId);
  if (!row) throw new CalendarAccessMissingError(userId);
  try {
    return await clientFor(userId, decrypt(row.refresh_token_enc));
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      await deleteCalendarToken(userId).catch(() => undefined);
      throw new CalendarAccessMissingError(userId);
    }
    throw err;
  }
}
