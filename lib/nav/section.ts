// Which top-rail section a path belongs to (components/views/AppNav.tsx). Pure, for tests.

export type NavSection = "/hem" | "/privat" | "/orgs" | "/foretag" | "/installningar";

const PREFIXES: NavSection[] = ["/hem", "/privat", "/foretag", "/orgs", "/installningar"];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * A company keeps its /orgs/<id> URLs but belongs to Företag, so a page under one of the user's
 * companies (`companyIds`) is Företag; every other /orgs page is Föreningar.
 */
export function navSection(path: string, companyIds: readonly string[]): NavSection | undefined {
  const org = /^\/orgs\/([^/?#]+)/.exec(path)?.[1];
  if (org && companyIds.includes(org)) return "/foretag";
  return PREFIXES.find((prefix) => under(path, prefix));
}
