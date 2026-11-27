import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { isUuid } from "@/lib/db/ids";
import { safeNextPath } from "@/lib/next-path";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * Refreshes the Supabase session on every page/API request, so Server Components (which
 * can't set cookies) always see a valid session. Standard @supabase/ssr pattern; cookies stay
 * httpOnly like in lib/supabase/server.ts. Authorization stays with the pages and routes; the
 * one thing done here is sending a signed-out visitor of the signed-in area (app/(app)) to the
 * login before any page renders: the page would otherwise query as `anon` in parallel with its
 * layout's redirect and log a "permission denied" server error on every such visit.
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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && request.method === "GET" && isSignedInArea(request.nextUrl.pathname)) {
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.search = "";
    const next = safeNextPath(request.nextUrl.pathname + request.nextUrl.search);
    if (next !== "/") to.searchParams.set("next", next);
    const redirect = NextResponse.redirect(to);
    // A failed refresh clears the session cookies: keep that on the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  // An unknown (or not my) förening: a real 404 status. The page's own notFound() comes after
  // app/(app)/loading.tsx has started streaming, so it can only answer 200 with the 404 view.
  // Documents only (a client navigation still gets the page's notFound view); RLS decides.
  const org = orgPageId(request.nextUrl.pathname);
  if (user && org !== null && request.method === "GET" && request.headers.get("sec-fetch-dest") === "document" && !request.headers.get("rsc")) {
    const known = isUuid(org) && (await supabase.from("orgs").select("id").eq("id", org).maybeSingle()).data !== null;
    if (!known) {
      const notFound = NextResponse.rewrite(new URL("/_finns-inte", request.url), { status: 404 });
      for (const cookie of response.cookies.getAll()) notFound.cookies.set(cookie);
      return notFound;
    }
  }

  // The Privat space (0045) is not a förening: every förening page below /orgs/<id>/ (protokoll,
  // förbered, kom igång) and every /api/orgs/<id>/… route answers 404 for it. One guard here
  // instead of one per route; /orgs/<id> itself redirects to /privat (the page does it).
  const guarded = privatGuardedOrgId(request.nextUrl.pathname);
  if (user && guarded !== null && isUuid(guarded)) {
    const { data } = await supabase.from("orgs").select("*").eq("id", guarded).maybeSingle();
    if ((data as { kind?: string } | null)?.kind === "privat") {
      const notFound = request.nextUrl.pathname.startsWith("/api/")
        ? NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } })
        : NextResponse.rewrite(new URL("/_finns-inte", request.url), { status: 404 });
      for (const cookie of response.cookies.getAll()) notFound.cookies.set(cookie);
      return notFound;
    }
  }

  return response;
}

/** The org id of a route a Privat space must not reach: `/api/orgs/<id>[/…]` and `/orgs/<id>/<page>`. */
export function privatGuardedOrgId(pathname: string): string | null {
  return /^\/api\/orgs\/([^/]+)(\/|$)/.exec(pathname)?.[1] ?? /^\/orgs\/([^/]+)\/[^/]/.exec(pathname)?.[1] ?? null;
}

/** The förening id of an org page (`/orgs/<id>` and below), or null. */
export function orgPageId(pathname: string): string | null {
  return /^\/orgs\/([^/]+)(\/|$)/.exec(pathname)?.[1] ?? null;
}

/** The pages of app/(app) (its layout requires a user). */
export function isSignedInArea(pathname: string): boolean {
  return /^\/(orgs|foretag|installningar)(\/|$)/.test(pathname);
}

export const config = {
  // Skip static assets (incl. public/pcm-worklet.js), the OAuth callback (it sets the session itself) and cron/health.
  // The MCP server and its OAuth endpoints (Bearer tokens, no session cookies) skip it too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|auth/callback|api/health|api/mcp|api/oauth/|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js)$).*)"],
};
