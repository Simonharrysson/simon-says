// Allowed in a query string or hash: printable ASCII without spaces, quotes, angle brackets or
// backslashes (a browser treats "\" as "/", so "/\evil.com" must never pass).
const SAFE_TAIL = /^[A-Za-z0-9\-_.~!$&'()*+,;=:@/?%]*$/;

/**
 * A same-site path to return to after login, or "/" when the value isn't one. The path is plain
 * letters, digits, "/", "-" and "_" (no "//host", no scheme, no ".."); a query string and hash
 * after it are kept (`/orgs/<id>?flik=installningar#sammanfattning`).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || value.startsWith("//")) return "/";
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  const tail = cut === -1 ? "" : value.slice(cut);
  if (!/^\/[A-Za-z0-9\-_/]*$/.test(path) || path.startsWith("//")) return "/";
  const hash = tail.indexOf("#");
  const query = hash === -1 ? tail : tail.slice(0, hash);
  const fragment = hash === -1 ? "" : tail.slice(hash + 1);
  if (!SAFE_TAIL.test(query) || !SAFE_TAIL.test(fragment.replace(/\?/g, ""))) return "/";
  return value;
}

/** `path` with `key=value` added to its query string (before any hash). */
export function withParam(path: string, key: string, value: string): string {
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const frag = hash === -1 ? "" : path.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}${frag}`;
}

/** `/login?fel=<code>`, keeping a safe `next` (e.g. an invite link) so a retry still lands there. */
export function loginErrorPath(fel: string, next: string | null | undefined): string {
  const safe = safeNextPath(next);
  return safe === "/" ? `/login?fel=${fel}` : `/login?fel=${fel}&next=${encodeURIComponent(safe)}`;
}
