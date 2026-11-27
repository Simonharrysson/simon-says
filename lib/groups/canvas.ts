// The tree as a canvas (0055): which arrows may be drawn, and where cards go when nobody placed them.
// Pure; the database (groups_tree trigger, set_group) decides again on every write.

import { parentChoices, treeRows, type GroupRow } from "@/lib/foretag/tree";

/** The trigger's limit (0050 groups_tree): more than 20 steps up from a parent is refused. */
export const MAX_DEPTH = 20;

export interface XY {
  x: number;
  y: number;
}

export type ConnectCheck =
  | { ok: true; /** The child's current parent, replaced by this arrow (one parent per group). */ replaces: string | null }
  | { ok: false; reason: "missing" | "self" | "same" | "cycle" | "depth" };

const active = <T extends GroupRow>(groups: T[]) => groups.filter((g) => !g.archived_at);

/** Every active group below `id` (not `id` itself). */
export function descendants<T extends GroupRow>(groups: T[], id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const g of active(groups)) if (g.parent_group_id) kids.set(g.parent_group_id, [...(kids.get(g.parent_group_id) ?? []), g.id]);
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(kids.get(next) ?? []));
  }
  return out;
}

/** Steps from `id` up to its root (0 for a root), over active groups; a broken or archived parent ends the walk. */
function levelOf<T extends GroupRow>(groups: T[], id: string): number {
  const byId = new Map(active(groups).map((g) => [g.id, g]));
  let steps = 0;
  let walk = byId.get(id)?.parent_group_id ?? null;
  const seen = new Set<string>([id]);
  while (walk && byId.has(walk) && !seen.has(walk)) {
    seen.add(walk);
    steps++;
    walk = byId.get(walk)!.parent_group_id;
  }
  return steps;
}

/** How many levels hang under `id` (0 for a leaf). */
function heightBelow<T extends GroupRow>(groups: T[], id: string): number {
  const kids = active(groups).filter((g) => g.parent_group_id === id);
  return kids.length ? 1 + Math.max(...kids.map((k) => heightBelow(groups, k.id))) : 0;
}

/**
 * May an arrow go from `parentId` (its bottom) down to `childId` (its top)? Exactly one parent per
 * group: an arrow into a child that already has a parent replaces that one. Never a cycle, never
 * deeper than the trigger allows.
 */
export function connectCheck<T extends GroupRow>(groups: T[], parentId: string, childId: string): ConnectCheck {
  const byId = new Map(active(groups).map((g) => [g.id, g]));
  const parent = byId.get(parentId);
  const child = byId.get(childId);
  if (!parent || !child) return { ok: false, reason: "missing" };
  if (parentId === childId) return { ok: false, reason: "self" };
  if (child.parent_group_id === parentId) return { ok: false, reason: "same" };
  if (!parentChoices(groups, childId).some((g) => g.id === parentId)) return { ok: false, reason: "cycle" };
  if (levelOf(groups, parentId) + 1 + heightBelow(groups, childId) > MAX_DEPTH) return { ok: false, reason: "depth" };
  const replaces = child.parent_group_id && byId.has(child.parent_group_id) ? child.parent_group_id : null;
  return { ok: true, replaces };
}

/** The groups with `childId` moved under `parentId` (null: to the top), depths recomputed. For optimistic UI. */
export function withParent<T extends GroupRow>(groups: T[], childId: string, parentId: string | null): T[] {
  const moved = groups.map((g) => (g.id === childId ? { ...g, parent_group_id: parentId } : g));
  return moved.map((g) => (g.archived_at ? g : { ...g, depth: levelOf(moved, g.id) }));
}

export interface LayoutOptions {
  width: number;
  height: number;
  gapX: number;
  gapY: number;
}

export const CARD: LayoutOptions = { width: 264, height: 132, gapX: 40, gapY: 96 };

/**
 * A tidy top-down layout: each tree in `treeRows` order, every parent centred over its children,
 * siblings side by side, trees next to each other. Deterministic (same groups, same picture).
 */
export function layoutTree<T extends GroupRow>(groups: T[], opts: LayoutOptions = CARD): Map<string, XY> {
  const rows = treeRows(groups);
  const ids = new Set(rows.map((r) => r.group.id));
  const children = new Map<string | null, string[]>();
  for (const { group } of rows) {
    const parent = group.parent_group_id && ids.has(group.parent_group_id) ? group.parent_group_id : null;
    children.set(parent, [...(children.get(parent) ?? []), group.id]);
  }
  const span = new Map<string, number>();
  const measure = (id: string): number => {
    const kids = children.get(id) ?? [];
    const w = kids.length ? Math.max(opts.width, kids.reduce((sum, k) => sum + measure(k), 0) + opts.gapX * (kids.length - 1)) : opts.width;
    span.set(id, w);
    return w;
  };
  const out = new Map<string, XY>();
  const place = (id: string, left: number, level: number) => {
    const w = span.get(id)!;
    const kids = children.get(id) ?? [];
    const used = kids.reduce((sum, k) => sum + span.get(k)!, 0) + opts.gapX * Math.max(0, kids.length - 1);
    let x = left + (w - used) / 2;
    for (const k of kids) {
      place(k, x, level + 1);
      x += span.get(k)! + opts.gapX;
    }
    const centre = kids.length ? (out.get(kids[0])!.x + out.get(kids[kids.length - 1])!.x) / 2 : left + (w - opts.width) / 2;
    out.set(id, { x: centre, y: level * (opts.height + opts.gapY) });
  };
  let left = 0;
  for (const root of children.get(null) ?? []) {
    const w = measure(root);
    place(root, left, 0);
    left += w + opts.gapX * 2;
  }
  return out;
}

/**
 * Where every active group's card is: its saved place, else the layout. Cards without a saved
 * place, when others have one, go below what is already placed (never on top of a card).
 */
export function canvasPositions<T extends GroupRow>(groups: T[], opts: LayoutOptions = CARD): Map<string, XY> {
  const layout = layoutTree(groups, opts);
  const saved = new Map<string, XY>();
  for (const g of active(groups)) if (typeof g.canvas_x === "number" && typeof g.canvas_y === "number") saved.set(g.id, { x: g.canvas_x, y: g.canvas_y });
  if (!saved.size) return layout;
  const missing = [...layout.keys()].filter((id) => !saved.has(id));
  if (!missing.length) return saved;
  const savedLeft = Math.min(...[...saved.values()].map((p) => p.x));
  const savedBottom = Math.max(...[...saved.values()].map((p) => p.y)) + opts.height + opts.gapY;
  const minX = Math.min(...missing.map((id) => layout.get(id)!.x));
  const minY = Math.min(...missing.map((id) => layout.get(id)!.y));
  const out = new Map(saved);
  for (const id of missing) {
    const p = layout.get(id)!;
    out.set(id, { x: p.x - minX + savedLeft, y: p.y - minY + savedBottom });
  }
  return out;
}

/** A free spot for a new card: right of everything, level with the top. */
export function nextFreeSpot(positions: Iterable<XY>, opts: LayoutOptions = CARD): XY {
  const all = [...positions];
  if (!all.length) return { x: 0, y: 0 };
  return { x: Math.max(...all.map((p) => p.x)) + opts.width + opts.gapX * 2, y: Math.min(...all.map((p) => p.y)) };
}

export const snap = (v: number, grid: number) => Math.round(v / grid) * grid;

/** Two letters for an avatar: "Anna Berg" → "AB", "kim@x.se" → "KI". */
export function initials(name: string): string {
  const words = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
