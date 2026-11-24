import { NextResponse, type NextRequest } from "next/server";
import { hasGoogleToken, storeGoogleToken } from "@/lib/google/client";
import { fetchGrantedScope, hasDriveFile } from "@/lib/google/scopes";
import { safeNextPath } from "@/lib/next-path";
import { originFrom } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth return from Supabase (PKCE). Exchanges the code, asks Google which scopes were
 * really granted, and stores the encrypted refresh token. Logs only booleans and the scope.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request.headers);
  const to = (path: string) => NextResponse.redirect(`${origin}${path}`);
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    const cancelled = request.nextUrl.searchParams.get("error") === "access_denied";
    return to(cancelled ? "/login?fel=avbrutet" : "/login?fel=kod");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    console.error("auth callback: code exchange failed", error?.message);
    return to("/login?fel=kod");
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
    }),
  );

  if (!driveFile) {
    await supabase.auth.signOut();
    return to("/login?fel=drive");
  }

  try {
    if (session.provider_refresh_token) {
      await storeGoogleToken(session.user.id, session.provider_refresh_token, scope);
    } else if (!(await hasGoogleToken(session.user.id))) {
      // Never overwrite a stored token with nothing; without any token we can't write Docs.
      await supabase.auth.signOut();
      return to("/login?fel=refresh");
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
    return to("/login?fel=kod");
  }

  return to(safeNextPath(request.nextUrl.searchParams.get("next")));
}
