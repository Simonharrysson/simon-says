import { isEmailCategory, withCategory } from "@/lib/email/categories";
import { loadEmailPrefs, saveAddressEmailPrefs } from "@/lib/email/prefs";
import { checkEmailPrefsToken } from "@/lib/email/token";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe (RFC 8058): mail apps POST "List-Unsubscribe=One-Click" here from the
 * List-Unsubscribe header, without cookies or an Origin. The signed token is the authorization;
 * it turns off one category for the address it names. GET does nothing (link scanners prefetch).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const email = checkEmailPrefsToken(url.searchParams.get("t"));
  const category = url.searchParams.get("k");
  if (!email || !isEmailCategory(category)) return new Response("Ogiltig länk", { status: 400 });
  const current = await loadEmailPrefs({ email });
  if (!current) return new Response("Försök igen", { status: 503 });
  const ok = await saveAddressEmailPrefs(email, withCategory(current, category, false));
  return new Response(ok ? "Avslutat" : "Försök igen", { status: ok ? 200 : 503 });
}
