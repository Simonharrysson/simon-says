// A person's optional role in the org (Ordförande, Kassör, PR ...). Shown next to the name and
// used as the owner label when a meeting's format groups by role (spec G5).

const ROLE = /^[\p{L}\p{M}\p{N}' .&\/-]{1,40}$/u;
export const ROLE_MAX_WORDS = 4;

export interface RolePerson {
  id: string;
  name: string;
  role?: string | null;
}

/** The cleaned role (NFC, single spaces, trimmed), or null when empty or not a role. "" clears. */
export function validRole(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\n\r:]/.test(raw)) return null;
  const role = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!role || !ROLE.test(role) || !/\p{L}/u.test(role)) return null;
  if (role.split(" ").length > ROLE_MAX_WORDS) return null;
  return role;
}

/** The role when grouping by role and the person has one, else the name, else the raw owner text. */
export function ownerLabel(
  person: { name: string; role?: string | null } | null,
  ownerText: string,
  groupBy: "role" | "person",
): string {
  if (!person) return ownerText;
  if (groupBy === "role" && person.role) return person.role;
  return person.name;
}

const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("sv");

/**
 * "kassören" -> "kassör", "ordföranden" -> "ordförande", "sekreteraren" -> "sekreterare",
 * "PR-ansvarige" -> "PR-ansvarig" (an adjective role's definite form). Both sides of a match are
 * stemmed, so a base form ending in -e ("ordförande") still matches itself.
 */
function stems(word: string): string[] {
  const out = new Set([word]);
  for (const suffix of ["en", "n", "et", "e"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) out.add(word.slice(0, -suffix.length));
  }
  return [...out];
}

/** Who "Anna", "Anna Berg" or "kassören" means: full name, then a unique first name, then a unique role. */
export function resolveOwner(ownerText: string, people: RolePerson[]): RolePerson | null {
  const text = norm(ownerText);
  if (!text) return null;
  const byName = people.filter((p) => norm(p.name) === text);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const byFirst = people.filter((p) => norm(p.name).split(" ")[0] === text);
  if (byFirst.length === 1) return byFirst[0];
  if (byFirst.length > 1) return null;
  const wanted = stems(text);
  const byRole = people.filter((p) => {
    if (!p.role) return false;
    const role = norm(p.role);
    const roleStems = stems(role);
    return wanted.some((w) => w === role || roleStems.includes(w));
  });
  return byRole.length === 1 ? byRole[0] : null;
}
