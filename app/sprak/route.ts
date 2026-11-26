import { NextResponse, type NextRequest } from "next/server";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, safeReturnPath } from "@/lib/i18n/config";
import { saveMyLocale } from "@/lib/i18n/user-locale";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The footer's "English / Svenska" link: `/sprak?till=en&tillbaka=/login`. Sets the `lang`
 * cookie, saves the choice on the account when someone is signed in, and goes back (same-origin
 * paths only). A plain GET so it works without JavaScript; it only changes the caller's own
 * language, so a forged link can do no harm beyond that.
 */
export async function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get("till");
  const back = safeReturnPath(request.nextUrl.searchParams.get("tillbaka"));
  const response = NextResponse.redirect(`${appOrigin()}${back}`, 303);
  if (!isLocale(to)) return response;
  response.cookies.set(LOCALE_COOKIE, to, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
  try {
    const db = await createSupabaseServerClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (user) await saveMyLocale(db, to);
  } catch {
    // Signed out or the database is away: the cookie alone still switches the page.
  }
  return response;
}
