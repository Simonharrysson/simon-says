import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * Refreshes the Supabase session on every page/API request, so Server Components (which
 * can't set cookies) always see a valid session. Standard @supabase/ssr pattern; cookies stay
 * httpOnly like in lib/supabase/server.ts. No authorization here: pages and routes check.
 */
export async function proxy(request: NextRequest) {
  const env = getEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // Validates the token with Supabase Auth and refreshes it when expired.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Skip static assets (incl. public/pcm-worklet.js), the OAuth callback (it sets the session itself) and cron/health.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|auth/callback|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js)$).*)"],
};
