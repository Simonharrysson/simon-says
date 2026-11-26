import { NextResponse, type NextRequest } from "next/server";
import { hasGoogleToken, storeGoogleToken } from "@/lib/google/client";
import { fetchGrantedScope, hasDriveFile, hasDriveReadonly } from "@/lib/google/scopes";
import { loginErrorPath, safeNextPath } from "@/lib/next-path";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth return from Supabase (PKCE). Exchanges the code, asks Google which scopes were
 * really granted, and stores the encrypted refresh token. Logs only booleans and the scope.
 *
 * `atkomst=drive`: the protocol import's incremental consent for drive.readonly (an admin who is
 * already signed in, app/(app)/orgs/drive-access.ts). It returns to the import whatever happens:
 * `?drive=ok` with the scope granted, `?drive=nej` when the admin cancelled or unticked it.
 */
export async function GET(request: NextRequest) {
  const origin = appOrigin();
  const to = (path: string) => NextResponse.redirect(`${origin}${path}`);
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next");
  const fail = (fel: string) => to(loginErrorPath(fel, next));
  const driveRequest = request.nextUrl.searchParams.get("atkomst") === "drive" && safeNextPath(next) !== "/";
  const backToImport = (result: "ok" | "nej") => to(`${safeNextPath(next)}?drive=${result}`);
  const supabase = await createSupabaseServerClient();
  if (!code) {
    const cancelled = request.nextUrl.searchParams.get("error") === "access_denied";
    // Saying no to the extra access must not cost the admin their session: back to the import.
    if (driveRequest && cancelled) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) return backToImport("nej");
    }
    return fail(cancelled ? "avbrutet" : "kod");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    console.error("auth callback: code exchange failed", error?.message);
    return fail("kod");
  }

  const { session } = data;
  const scope = session.provider_token ? await fetchGrantedScope(session.provider_token) : null;
  const driveFile = scope !== null && hasDriveFile(scope);
  const hasRefreshToken = Boolean(session.provider_refresh_token);
  console.info(
    "auth callback",
    JSON.stringify({
      user: session.user.id,
      hasProviderToken: Boolean(session.provider_token),
      hasProviderRefreshToken: hasRefreshToken,
      grantedScope: scope,
      driveFile,
      ...(driveRequest ? { driveReadonly: hasDriveReadonly(scope) } : {}),
    }),
  );

  if (!driveFile) {
    await supabase.auth.signOut();
    return fail("drive");
  }

  try {
    if (session.provider_refresh_token) {
      await storeGoogleToken(session.user.id, session.provider_refresh_token, scope);
    } else if (!(await hasGoogleToken(session.user.id))) {
      // Never overwrite a stored token with nothing; without any token we can't write Docs.
      await supabase.auth.signOut();
      return fail("refresh");
    }
    // The exchanged session carries provider_token/provider_refresh_token and would be saved
    // as-is in the session cookie. Re-save it without them: Google tokens live only in
    // google_tokens, encrypted.
    const { error: resaveError } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (resaveError) throw resaveError;
  } catch (err) {
    console.error("auth callback: storing Google token failed", (err as Error)?.message);
    await supabase.auth.signOut();
    return fail("kod");
  }

  if (driveRequest) return backToImport(hasDriveReadonly(scope) ? "ok" : "nej");
  return to(safeNextPath(next));
}
