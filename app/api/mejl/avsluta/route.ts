import { isEmailCategory } from "@/lib/email/categories";
import { unsubscribeCategory } from "@/lib/email/prefs";
import { checkEmailPrefsToken } from "@/lib/email/token";
import { appOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe (RFC 8058): mail apps POST "List-Unsubscribe=One-Click" here from the
 * List-Unsubscribe header, without cookies or an Origin. The signed token is the authorization;
 * it turns off one category for the address it names. GET (a mail app without one-click opens the
 * URL in a browser, and link scanners prefetch it) changes nothing: it shows the /mejl page.
 */
export async function GET(request: Request) {
  const from = new URL(request.url);
  const to = new URL("/mejl", appOrigin());
  for (const key of ["t", "k"]) {
    const value = from.searchParams.get(key);
    if (value) to.searchParams.set(key, value);
  }
  return Response.redirect(to, 303);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const email = checkEmailPrefsToken(url.searchParams.get("t"));
  const category = url.searchParams.get("k");
  if (!email || !isEmailCategory(category)) return new Response("Ogiltig länk", { status: 400 });
  const ok = await unsubscribeCategory(email, category);
  return new Response(ok ? "Avslutat" : "Försök igen", { status: ok ? 200 : 503 });
}
