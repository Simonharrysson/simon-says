// Teams, never group names (0062): a group is shown as its head's team ("Simons team"), the top
// group as the top of the tree. Pure; the words come from the caller (lib/i18n/messages).

import type { GroupRow } from "@/lib/foretag/tree";

/** "Simon Berg" → "Simons" (sv), "Jonas" → "Jonas", "Simon" → "Simon's" (en). The first name only. */
export function ownerOf(name: string, locale: string): string {
  const first = name.trim().split(/\s+/)[0] || name.trim();
  if (locale === "en") return /s$/i.test(first) ? `${first}'` : `${first}'s`;
  return /[sxz]$/i.test(first) ? first : `${first}s`;
}

export interface TeamWords {
  /** "{owner} team" with the owner's genitive filled in. */
  team: (owner: string) => string;
  /** The top group (no head). */
  top: string;
}

/** The groups with `name` replaced by what people see. `heads`: person id → name. */
export function labelTeams<T extends GroupRow>(groups: T[], heads: Map<string, string>, words: TeamWords, locale: string): T[] {
  return groups.map((g) => {
    const head = g.head_person_id ? heads.get(g.head_person_id) : undefined;
    return { ...g, name: head ? words.team(ownerOf(head, locale)) : !g.parent_group_id ? words.top : g.name };
  });
}
