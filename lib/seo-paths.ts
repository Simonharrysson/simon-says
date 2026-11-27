// Which paths search engines may index. No imports: next.config.ts reads this file too.

/** The public pages, for app/sitemap.ts. Everything else is signed-in or a one-off link. */
export const PUBLIC_PATHS = ["/", "/login", "/integritet", "/status"] as const;

/**
 * The prefixes crawlers stay out of (app/robots.ts) and that answer `X-Robots-Tag: noindex`
 * (next.config.ts): the signed-in area, one-off links and the API.
 */
export const PRIVATE_PREFIXES = [
  "/api/",
  "/auth/",
  "/hem",
  "/orgs",
  "/privat",
  "/installningar",
  "/meetings",
  "/join",
  "/mejl",
  "/inloggad",
  "/design",
  "/sprak",
] as const;
