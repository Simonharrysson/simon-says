import { NextResponse, type NextRequest } from "next/server";
import { hasGoogleToken, storeCalendarToken, storeGoogleToken, storeImportToken } from "@/lib/google/client";
import { fetchGrantedScope, hasCalendarReadonly, hasDriveFile, hasDriveReadonly } from "@/lib/google/scopes";
import { defaultLocale, isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/i18n/config";
import { loadMyLocale, saveMyLocale } from "@/lib/i18n/user-locale";
import { loginErrorPath, safeNextPath, withParam } from "@/lib/next-path";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth return from Supabase (PKCE). Exchanges the code, asks Google which scopes were
 * really granted, and stores the encrypted refresh token. Logs only booleans and the scope.
 *
 * `atkomst=drive`: the protocol import's incremental consent for drive.readonly (an admin who is
 * already signed in, app/(app)/orgs/drive-access.ts). Its refresh token goes to the import's own
 * store (google_import_tokens), never over the sign-in token. It returns to the import whatever
 * happens: `?drive=ok` granted, `nej` cancelled or unticked, `fel` no token, `konto` the admin
 * picked another Google account than the one they are signed in with (that session is signed
 * out again, the admin's own restored, nothing stored).
 *
 * `atkomst=kalender`: "Koppla kalender" (calendar.readonly, todo #14), the same way: the same
 * account check, the token stored apart (google_calendar_tokens, never over the sign-in token), and
 * back to where it was asked (`?kalender=ok|nej|fel|konto`).
 */
export async function GET(request: NextRequest) {
  const origin = appOrigin();
  const to = (path: string) => NextResponse.redirect(`${origin}${path}`);
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next");
  const fail = (fel: string) => to(loginErrorPath(fel, next));
  const atkomst = request.nextUrl.searchParams.get("atkomst");
  // An extra-access consent of a signed-in user: drive.readonly (the import) or calendar.readonly.
  const access = (atkomst === "drive" || atkomst === "kalender") && safeNextPath(next) !== "/" ? atkomst : null;
  const driveRequest = access !== null;
  const backToImport = (result: "ok" | "nej" | "fel" | "konto") => to(withParam(safeNextPath(next), access!, result));
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

  // The drive consent must come back as the same user: remember who is signed in now.
  const before = driveRequest ? (await supabase.auth.getSession()).data.session : null;
  const beforeUser = before ? (await supabase.auth.getUser()).data.user : null;

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
      ...(access === "drive" ? { driveReadonly: hasDriveReadonly(scope) } : {}),
      ...(access === "kalender" ? { calendarReadonly: hasCalendarReadonly(scope) } : {}),
    }),
  );

  if (driveRequest) return finishDriveRequest();

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

  return withSavedLocale(to(safeNextPath(next)));

  /**
   * The account's saved UI language (0043) follows it to this browser via the `lang` cookie. With
   * none saved, an English choice made while signed out becomes the account's. Best effort.
   */
  async function withSavedLocale(response: NextResponse) {
    try {
      const saved = await loadMyLocale(supabase, session.user.id);
      const current = request.cookies.get(LOCALE_COOKIE)?.value;
      if (saved) response.cookies.set(LOCALE_COOKIE, saved, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
      else if (isLocale(current) && current !== defaultLocale) await saveMyLocale(supabase, current);
    } catch {
      // The cookie (or Swedish) stays.
    }
    return response;
  }

  async function finishDriveRequest() {
    if (!beforeUser || !before || beforeUser.id !== session.user.id) {
      console.warn(`auth callback: ${access} consent came back as another user; signing that session out`);
      await supabase.auth.signOut({ scope: "local" });
      if (!beforeUser || !before) return fail("kod");
      const { error: restoreError } = await supabase.auth.setSession({ access_token: before.access_token, refresh_token: before.refresh_token });
      if (restoreError) return fail("kod");
      return backToImport("konto");
    }
    let result: "ok" | "nej" | "fel" = "nej";
    try {
      const granted = access === "kalender" ? hasCalendarReadonly(scope) : hasDriveReadonly(scope);
      if (granted) {
        if (session.provider_refresh_token) {
          if (access === "kalender") await storeCalendarToken(session.user.id, session.provider_refresh_token, scope!);
          else await storeImportToken(session.user.id, session.provider_refresh_token, scope!);
          result = "ok";
        } else result = "fel";
      }
    } catch (err) {
      console.error(`auth callback: storing the ${access} token failed`, (err as Error)?.message);
      result = "fel";
    }
    // Same as a sign-in: the session cookie must not carry Google's tokens.
    const { error: resaveError } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (resaveError) {
      await supabase.auth.signOut();
      return fail("kod");
    }
    return backToImport(result);
  }
}
