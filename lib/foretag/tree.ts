// The tree of a Företag, or of a förening with groups turned on (0050, 0054), for the UI
// (Personer & grupper, Grupper, Möte för). Pure.

/**
 * Does this org follow the tree (meetings per group, the visibility rule, held tasks)? A Företag
 * always; a förening once an admin turned groups on (0054). Read from a whole orgs row (`*`).
 */
export function hasTree(org: { kind?: string | null; groups_enabled?: boolean | null } | null | undefined): boolean {
  return org?.kind === "foretag" || org?.groups_enabled === true;
}

export interface GroupRow {
  id: string;
  name: string;
  parent_group_id: string | null;
  depth: number;
  position: number;
  archived_at?: string | null;
  /** 0055: the card's place on the canvas (null: laid out by the app). Visual only. */
  canvas_x?: number | null;
  canvas_y?: number | null;
  /** 0055: the group's head (chef), display only; visibility follows the tree alone. */
  head_person_id?: string | null;
}

/** Active groups depth-first (each parent before its children), siblings by position then name. */
export function treeRows<T extends GroupRow>(groups: T[]): { group: T; depth: number }[] {
  const active = groups.filter((g) => !g.archived_at);
  const ids = new Set(active.map((g) => g.id));
  const children = new Map<string | null, T[]>();
  for (const g of active) {
    // A parent that is archived or gone: shown as a root, never lost.
    const parent = g.parent_group_id && ids.has(g.parent_group_id) ? g.parent_group_id : null;
    children.set(parent, [...(children.get(parent) ?? []), g]);
  }
  const order = (a: T, b: T) => a.position - b.position || a.name.localeCompare(b.name, "sv");
  const out: { group: T; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const g of (children.get(parent) ?? []).sort(order)) {
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The groups a group may move under: any active group except itself and its descendants. */
export function parentChoices<T extends GroupRow>(groups: T[], groupId: string | null): T[] {
  if (!groupId) return groups.filter((g) => !g.archived_at);
  const below = new Set<string>([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parent_group_id && below.has(g.parent_group_id) && !below.has(g.id)) {
        below.add(g.id);
        grew = true;
      }
    }
  }
  return groups.filter((g) => !g.archived_at && !below.has(g.id));
}

/** Who sees a group's meetings, by the rule (for the UI's explanation line): the groups at or above its level, by name. */
export function seenByGroups<T extends GroupRow>(groups: T[], group: T): T[] {
  return groups.filter((g) => !g.archived_at && g.id !== group.id && g.depth < group.depth);
}
