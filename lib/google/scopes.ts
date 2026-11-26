export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

/**
 * Read access to the user's whole Drive. Asked ONLY of an admin who starts "Läs in gamla
 * protokoll", by incremental consent (include_granted_scopes), never at sign-in: it lets Simon
 * Says list the meeting titles in the folders the admin picks. A Google "restricted" scope.
 */
export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

/** The only scopes we ask for at sign-in. */
export const GOOGLE_SCOPES = ["openid", "email", "profile", DRIVE_FILE] as const;

/** The incremental request for the protocol import: the sign-in scopes plus drive.readonly. */
export const IMPORT_SCOPES = [...GOOGLE_SCOPES, DRIVE_READONLY] as const;

/** True when a space-separated granted-scope string includes drive.file. */
export function hasDriveFile(grantedScope: string): boolean {
  return grantedScope.split(/\s+/).includes(DRIVE_FILE);
}

/** True when a space-separated granted-scope string includes drive.readonly. */
export function hasDriveReadonly(grantedScope: string | null | undefined): boolean {
  return !!grantedScope && grantedScope.split(/\s+/).includes(DRIVE_READONLY);
}

/**
 * The scopes Google actually granted for an access token. Supabase's session does not
 * report them (it only echoes provider_token / provider_refresh_token), so ask Google.
 * Returns null if Google doesn't answer with a scope.
 */
export async function fetchGrantedScope(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl("https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: accessToken }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { scope?: unknown };
  return typeof body.scope === "string" ? body.scope : null;
}
