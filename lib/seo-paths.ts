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
  "/foretag",
  "/privat",
  "/installningar",
  "/meetings",
  "/mejl",
  "/inloggad",
  "/design",
  "/sprak",
  "/koppla",
  "/oauth",
] as const;

/**
 * Not indexed, but crawlable: shared invite links. Link previews and crawlers must be able to
 * fetch them to see the `X-Robots-Tag: noindex` header (a robots.txt block would hide it).
 */
export const NOINDEX_ONLY_PREFIXES = ["/join", "/in", "/r"] as const;
