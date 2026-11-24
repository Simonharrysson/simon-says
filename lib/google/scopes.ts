export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

/** The only scopes we ever ask for. */
export const GOOGLE_SCOPES = ["openid", "email", "profile", DRIVE_FILE] as const;

/** True when a space-separated granted-scope string includes drive.file. */
export function hasDriveFile(grantedScope: string): boolean {
  return grantedScope.split(/\s+/).includes(DRIVE_FILE);
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
