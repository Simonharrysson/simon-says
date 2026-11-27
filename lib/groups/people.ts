// The people tree (0062): who reports to whom, read from the groups underneath. A person sits in a
// group; that group's head (head_person_id) is their manager; the top group (no head) means no
// manager; no place (group_id null, or an archived group) means outside the tree. Pure.

import type { GroupRow } from "@/lib/foretag/tree";

export interface PersonRow {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  member_user_id: string | null;
  group_id: string | null;
  canvas_x?: number | null;
  canvas_y?: number | null;
  /** 0051: the member linked themself ("Vem av dessa är du?"); turning the tree on leaves them for an admin to place. */
  self_linked_at?: string | null;
}

export interface Member {
  userId: string;
  email: string;
  role: "admin" | "member";
}

export interface TreePersonView {
  /** `p:<person id>` for a person row, `u:<user id>` for a member account without one. */
  key: string;
  personId: string | null;
  userId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  admin: boolean;
  you: boolean;
  /** In the tree (has a place). */
  placed: boolean;
  /** Who they report to (a person id), or null: at the top, or outside the tree. */
  managerId: string | null;
  canvas_x: number | null;
  canvas_y: number | null;
}

export function peopleTree(people: PersonRow[], groups: GroupRow[], members: Member[], userId: string): TreePersonView[] {
  const active = new Map(groups.filter((g) => !g.archived_at).map((g) => [g.id, g]));
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const placedIds = new Set(people.filter((p) => p.group_id && active.has(p.group_id)).map((p) => p.id));
  const linked = new Set(people.flatMap((p) => (p.member_user_id ? [p.member_user_id] : [])));
  const rows: TreePersonView[] = people.map((p) => {
    const m = p.member_user_id ? byUser.get(p.member_user_id) : undefined;
    const group = p.group_id ? active.get(p.group_id) : undefined;
    const head = group?.head_person_id ?? null;
    return {
      key: `p:${p.id}`,
      personId: p.id,
      userId: p.member_user_id,
      name: p.name,
      role: p.role ?? null,
      email: p.email ?? m?.email ?? null,
      admin: m?.role === "admin",
      you: p.member_user_id !== null && p.member_user_id === userId,
      placed: Boolean(group),
      managerId: head && head !== p.id && placedIds.has(head) ? head : null,
      canvas_x: p.canvas_x ?? null,
      canvas_y: p.canvas_y ?? null,
    };
  });
  // A manager chain that loops (only possible in hand-edited data): cut it at the top.
  const byId = new Map(rows.map((r) => [r.personId!, r]));
  for (const r of rows) {
    const seen = new Set<string>([r.personId!]);
    let walk = r.managerId;
    while (walk) {
      if (seen.has(walk)) {
        r.managerId = null;
        break;
      }
      seen.add(walk);
      walk = byId.get(walk)?.managerId ?? null;
    }
  }
  const accounts: TreePersonView[] = members
    .filter((m) => !linked.has(m.userId))
    .map((m) => ({
      key: `u:${m.userId}`,
      personId: null,
      userId: m.userId,
      name: m.email,
      role: null,
      email: m.email,
      admin: m.role === "admin",
      you: m.userId === userId,
      placed: false,
      managerId: null,
      canvas_x: null,
      canvas_y: null,
    }));
  return [...rows.sort((a, b) => a.name.localeCompare(b.name, "sv")), ...accounts];
}

/**
 * The placed people as tree rows (id = person id, parent = manager), so the tree helpers
 * (treeRows, connectCheck, layoutTree, canvasPositions) work on people exactly as on groups.
 */
export function asTreeRows(people: TreePersonView[]): GroupRow[] {
  const placed = people.filter((p) => p.placed && p.personId);
  const byId = new Map(placed.map((p) => [p.personId!, p]));
  const depth = (p: TreePersonView): number => {
    let d = 0;
    let walk = p.managerId;
    while (walk && byId.has(walk) && d < 100) {
      d++;
      walk = byId.get(walk)!.managerId;
    }
    return d;
  };
  return placed.map((p) => ({
    id: p.personId!,
    name: p.name,
    parent_group_id: p.managerId,
    depth: depth(p),
    position: 0,
    canvas_x: p.canvas_x,
    canvas_y: p.canvas_y,
  }));
}
