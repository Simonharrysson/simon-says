/**
 * A same-site path to return to after login, or "/" when the value isn't one. Only plain
 * paths of letters, digits, "/", "-" and "_" pass (no "//host", no scheme, no query).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !/^\/[A-Za-z0-9\-_/]*$/.test(value) || value.startsWith("//")) return "/";
  return value;
}

/** `/login?fel=<code>`, keeping a safe `next` (e.g. an invite link) so a retry still lands there. */
export function loginErrorPath(fel: string, next: string | null | undefined): string {
  const safe = safeNextPath(next);
  return safe === "/" ? `/login?fel=${fel}` : `/login?fel=${fel}&next=${encodeURIComponent(safe)}`;
}
