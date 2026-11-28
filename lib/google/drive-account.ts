import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OAuth2Client } from "google-auth-library";
import { decrypt, encrypt } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { clientForRefreshToken, getGoogleAuth, GoogleAuthLostError } from "./client";
import {
  chooseCreationAccount,
  chooseExistingAccount,
  choosePickerAccount,
  type CreationChoice,
  type DriveAccountState,
} from "./drive-account-rules";

// The förening's own Drive account (0070, org_drive_accounts). Its refresh token is stored like
// every other Google token (lib/crypto.ts, service role only) and never leaves the server, except
// as a short-lived Picker access token for the admin who connected it (picker-token route).
// Logs carry org ids only, never addresses or tokens.

/**
 * The förening's Drive account is gone, replaced by another account, or refused by Google. A
 * GoogleAuthLostError, so every Doc path treats it as a lost grant (the tick pauses the Doc, a
 * start or share stops): never a write through another account.
 */
export class DriveAccountLostError extends GoogleAuthLostError {
  constructor(readonly orgId: string, reason: string) {
    super(`org:${orgId}`, `förening Drive account: ${reason}`);
    this.name = "DriveAccountLostError";
  }
}

const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

interface Row {
  org_id: string;
  connected_by: string;
  google_sub: string;
  google_email: string;
  folder_id: string | null;
  lost_at: string | null;
  updated_at: string;
}

const COLUMNS = "org_id, connected_by, google_sub, google_email, folder_id, lost_at, updated_at";
const stateOf = (r: Row): DriveAccountState => ({
  googleSub: r.google_sub,
  googleEmail: r.google_email,
  connectedBy: r.connected_by,
  folderId: r.folder_id,
  lostAt: r.lost_at,
});

/** The förening's Drive account (no token), or null. A database without 0070: null. */
export async function orgDriveAccount(orgId: string): Promise<(DriveAccountState & { updatedAt: string }) | null> {
  const { data, error } = await supabaseAdmin().from("org_drive_accounts").select(COLUMNS).eq("org_id", orgId).maybeSingle();
  if (error) {
    if (missingTable(error.code)) return null;
    throw new Error(`orgDriveAccount: ${error.message}`);
  }
  return data ? { ...stateOf(data as Row), updatedAt: (data as Row).updated_at } : null;
}

/**
 * Connect (or renew, or replace) the förening's account. The same Google account again keeps its
 * picked folder; another account starts without one (its Picker must pick the folder again).
 */
export async function storeOrgDriveAccount(input: {
  orgId: string;
  connectedBy: string;
  googleSub: string;
  googleEmail: string;
  refreshToken: string;
  scope: string;
}): Promise<void> {
  const before = await orgDriveAccount(input.orgId);
  const { error } = await supabaseAdmin()
    .from("org_drive_accounts")
    .upsert({
      org_id: input.orgId,
      connected_by: input.connectedBy,
      google_sub: input.googleSub,
      google_email: input.googleEmail.toLowerCase(),
      refresh_token_enc: encrypt(input.refreshToken),
      scope: input.scope,
      folder_id: before && before.googleSub === input.googleSub ? before.folderId : null,
      lost_at: null,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`storeOrgDriveAccount: ${error.message}`);
}

/**
 * "Koppla från": deletes OUR copy only. Not revoked at Google: the förening's account may also be
 * someone's sign-in account here, and revoking any token of a grant revokes the whole grant.
 */
export async function deleteOrgDriveAccount(orgId: string): Promise<void> {
  const { error } = await supabaseAdmin().from("org_drive_accounts").delete().eq("org_id", orgId);
  if (error) throw new Error(`deleteOrgDriveAccount: ${error.message}`);
}

/** The meeting folder was picked in this account's Picker (only that account's grant can add to it). */
export async function setOrgDriveFolder(orgId: string, googleSub: string, folderId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("org_drive_accounts")
    .update({ folder_id: folderId })
    .eq("org_id", orgId)
    .eq("google_sub", googleSub);
  if (error) throw new Error(`setOrgDriveFolder: ${error.message}`);
}

async function markLost(orgId: string, googleSub: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("org_drive_accounts")
    .update({ lost_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("google_sub", googleSub)
    .is("lost_at", null);
  if (error) console.error(`org drive ${orgId}: mark lost: ${error.message}`);
}

/**
 * A client of the förening's account `googleSub` (fresh access token fetched). A missing,
 * replaced or lost account is DriveAccountLostError; Google refusing it marks it lost (kept, so
 * admins see "behöver förnyas").
 */
export async function orgDriveClient(orgId: string, googleSub: string): Promise<OAuth2Client> {
  const { data, error } = await supabaseAdmin()
    .from("org_drive_accounts")
    .select(`${COLUMNS}, refresh_token_enc`)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error && !missingTable(error.code)) throw new Error(`orgDriveClient: ${error.message}`);
  const row = (data ?? null) as (Row & { refresh_token_enc: string }) | null;
  // Only the very account that made (or picked) it, and only while Google still accepts it.
  if (!row || chooseExistingAccount(stateOf(row), googleSub).use !== "org") throw new DriveAccountLostError(orgId, row ? "replaced or lost" : "not connected");
  try {
    return await clientForRefreshToken(`org:${orgId}`, decrypt(row.refresh_token_enc));
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      await markLost(orgId, googleSub);
      console.warn(`org drive ${orgId}: Google refused the förening's account; marked lost`);
      throw new DriveAccountLostError(orgId, "invalid_grant");
    }
    throw err;
  }
}

/** The grant an existing Doc is reached with: the account that made it (`driveAccountSub`), else the starter's. */
export async function docAuth(doc: { orgId: string; startedBy: string; driveAccountSub?: string | null }): Promise<OAuth2Client> {
  return doc.driveAccountSub ? orgDriveClient(doc.orgId, doc.driveAccountSub) : getGoogleAuth(doc.startedBy);
}

/**
 * The grant a NEW Doc for the meeting folder is made with (`folderId` null: never the förening's
 * account). `driveAccount.sub` goes on the new row (drive_account_sub); the Doc is then shared
 * with the starter too, who no longer owns it. Throws GoogleAuthLostError (the starter's) or
 * DriveAccountLostError (the förening's: renew it; nothing is created elsewhere instead).
 */
export async function creationAuth(
  orgId: string,
  folderId: string | null,
  userId: string,
): Promise<{ auth: OAuth2Client; driveAccount: { sub: string; email: string } | null }> {
  const account = folderId ? await orgDriveAccount(orgId) : null;
  const choice: CreationChoice = chooseCreationAccount(account, folderId);
  if (choice.use === "lost") throw new DriveAccountLostError(orgId, "lost");
  if (choice.use === "org") return { auth: await orgDriveClient(orgId, choice.sub), driveAccount: { sub: choice.sub, email: account!.googleEmail } };
  return { auth: await getGoogleAuth(userId), driveAccount: null };
}

/**
 * The grant behind the Picker for `userId` in this förening, and the one that reads what it picked
 * (format learning, stadgar, the meeting folder): the förening's account for the admin who
 * connected it, else the user's own.
 */
export async function pickerAuth(userId: string, orgId: string | null): Promise<{ auth: OAuth2Client; account: { sub: string; email: string } | null }> {
  const account = orgId ? await orgDriveAccount(orgId) : null;
  const choice = choosePickerAccount(account, userId);
  if (choice.use === "lost") throw new DriveAccountLostError(orgId!, "lost");
  if (choice.use === "org") return { auth: await orgDriveClient(orgId!, account!.googleSub), account: { sub: account!.googleSub, email: account!.googleEmail } };
  return { auth: await getGoogleAuth(userId), account: null };
}

/**
 * Which account made this row's Doc (0070 `drive_account_sub`), or null: the starter's / preparer's
 * own grant. A database without the column: null (no förening account can exist there either).
 */
export async function driveSubOf(table: "meetings" | "prepared_agendas", id: string, db: SupabaseClient = supabaseAdmin()): Promise<string | null> {
  const { data, error } = await db.from(table).select("drive_account_sub").eq("id", id).maybeSingle();
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") return null;
    throw new Error(`driveSubOf ${table}: ${error.message}`);
  }
  return ((data as { drive_account_sub?: string | null } | null)?.drive_account_sub ?? null) || null;
}
