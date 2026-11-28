import { NextResponse, type NextRequest } from "next/server";
import { RETURN_COOKIE, RETURN_COOKIE_MAX_AGE, claimInvite } from "@/lib/growth/claim";
import { inviteIdOf } from "@/lib/growth/token";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * After "Fortsätt med Google" (0063): the sign-in returns here (next=/in/<token>/klar). The claim
 * is a side effect of this GET, a deliberate exception to "joining is a POST" (one tap for the
 * invitee): it is safe because nothing happens without a signed-in session whose CONFIRMED address
 * is the invited one (claim_meeting_invite checks it), so a prefetching scanner or a forwarded
 * link gets nothing. Then the meeting page; otherwise back to the landing, which explains.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origin = appOrigin();
  const back = (fel?: string) => NextResponse.redirect(`${origin}/in/${token}${fel ? `?fel=${fel}` : ""}`, { status: 302, headers: { "cache-control": "no-store" } });
  if (!inviteIdOf(token)) return NextResponse.redirect(`${origin}/`, { status: 302 });
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent(`/in/${token}/klar`)}`, { status: 302 });
  let result: Awaited<ReturnType<typeof claimInvite>>;
  try {
    result = await claimInvite(token, user);
  } catch (e) {
    console.error(`invite claim: ${(e as Error).message}`.slice(0, 200));
    return back("fel");
  }
  switch (result.outcome) {
    case "ok":
    case "ok_again": {
      const res = NextResponse.redirect(`${origin}/orgs/${result.orgId}/mote/${result.meetingId}?fran=inbjudan`, { status: 302, headers: { "cache-control": "no-store" } });
      res.cookies.set(RETURN_COOKIE, "1", { path: "/", maxAge: RETURN_COOKIE_MAX_AGE, sameSite: "lax", httpOnly: true, secure: origin.startsWith("https:") });
      return res;
    }
    case "mismatch":
      return back("konto");
    case "used":
      return back("anvand");
    case "expired":
      return back("utgangen");
    case "gone":
      return back("borta");
    default:
      return back();
  }
}
