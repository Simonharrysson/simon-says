/**
 * A same-site path to return to after login, or "/" when the value isn't one. Only plain
 * paths of letters, digits, "/", "-" and "_" pass (no "//host", no scheme, no query).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !/^\/[A-Za-z0-9\-_/]*$/.test(value) || value.startsWith("//")) return "/";
  return value;
}
