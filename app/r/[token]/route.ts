import { NextResponse, type NextRequest } from "next/server";
import { recordClick } from "@/lib/growth/claim";
import { inviteIdOf } from "@/lib/growth/token";
import { appOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * The invite mail's button (0067): our own signed redirect. A GET only logs the click (mail
 * scanners prefetch links, so nothing is claimed here) and goes on to the landing, /in/<token>.
 * `?till=eget` (the footer's "starta ett eget möte") goes to the start page instead.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origin = appOrigin();
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  if (!inviteIdOf(token)) return NextResponse.redirect(`${origin}/`, { status: 302, headers });
  try {
    await recordClick(token, false);
  } catch (e) {
    console.error(`invite redirect: ${(e as Error).message}`.slice(0, 200));
  }
  const to = request.nextUrl.searchParams.get("till") === "eget" ? "/" : `/in/${token}`;
  return NextResponse.redirect(`${origin}${to}`, { status: 302, headers });
}
