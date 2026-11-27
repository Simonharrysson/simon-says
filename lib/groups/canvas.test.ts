import { describe, expect, it } from "vitest";
import type { GroupRow } from "@/lib/foretag/tree";
import { CARD, canvasPositions, connectCheck, descendants, initials, layoutTree, MAX_DEPTH, nextFreeSpot, snap, withParent } from "./canvas";

const g = (id: string, parent: string | null, depth: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  id,
  name: id,
  parent_group_id: parent,
  depth,
  position: 0,
  archived_at: null,
  ...extra,
});
// VD → Ledning → Utveckling, Kommunikation; Ekonomi on its own; Gammal archived under VD.
const tree = [g("VD", null, 0), g("Ledning", "VD", 1), g("Utveckling", "Ledning", 2), g("Kommunikation", "Ledning", 2, { position: 1 }), g("Ekonomi", null, 0, { position: 1 }), g("Gammal", "VD", 1, { archived_at: "2026-11-27" })];

describe("connectCheck: one parent, no cycles", () => {
  it("a top-level group may go under another", () => {
    expect(connectCheck(tree, "Ledning", "Ekonomi")).toEqual({ ok: true, replaces: null });
  });
  it("an arrow into a group that has a parent replaces that parent (exactly one)", () => {
    expect(connectCheck(tree, "VD", "Utveckling")).toEqual({ ok: true, replaces: "Ledning" });
  });
  it("never a group under itself", () => {
    expect(connectCheck(tree, "VD", "VD")).toEqual({ ok: false, reason: "self" });
  });
  it("never under its own child or grandchild (a cycle)", () => {
    expect(connectCheck(tree, "Ledning", "VD")).toEqual({ ok: false, reason: "cycle" });
    expect(connectCheck(tree, "Utveckling", "VD")).toEqual({ ok: false, reason: "cycle" });
    expect(connectCheck(tree, "Utveckling", "Ledning")).toEqual({ ok: false, reason: "cycle" });
  });
  it("the arrow that is already there is no change", () => {
    expect(connectCheck(tree, "Ledning", "Utveckling")).toEqual({ ok: false, reason: "same" });
  });
  it("archived or unknown groups take no arrows", () => {
    expect(connectCheck(tree, "Gammal", "Ekonomi")).toEqual({ ok: false, reason: "missing" });
    expect(connectCheck(tree, "VD", "nope")).toEqual({ ok: false, reason: "missing" });
  });
  it("mirrors the trigger's depth limit", () => {
    const chain = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => g(`c${i}`, i ? `c${i - 1}` : null, i));
    const deep = [...chain, g("leaf", null, 0)];
    expect(connectCheck(deep, `c${MAX_DEPTH - 1}`, "leaf")).toEqual({ ok: true, replaces: null });
    expect(connectCheck(deep, `c${MAX_DEPTH}`, "leaf")).toEqual({ ok: false, reason: "depth" });
    // A subtree counts too: a two-level group fits one level less deep.
    const sub = [...deep, g("leafKid", "leaf", 1)];
    expect(connectCheck(sub, `c${MAX_DEPTH - 1}`, "leaf")).toEqual({ ok: false, reason: "depth" });
  });
  it("descendants skip archived groups", () => {
    expect([...descendants(tree, "VD")].sort()).toEqual(["Kommunikation", "Ledning", "Utveckling"]);
  });
});

describe("withParent", () => {
  it("moves a subtree and recomputes depths", () => {
    const moved = withParent(tree, "Ledning", "Ekonomi");
    const depth = Object.fromEntries(moved.map((x) => [x.id, x.depth]));
    expect(depth).toMatchObject({ Ekonomi: 0, Ledning: 1, Utveckling: 2, VD: 0 });
    expect(moved.find((x) => x.id === "Ledning")!.parent_group_id).toBe("Ekonomi");
  });
  it("detaching makes a top-level group", () => {
    const moved = withParent(tree, "Utveckling", null);
    expect(moved.find((x) => x.id === "Utveckling")).toMatchObject({ parent_group_id: null, depth: 0 });
  });
});

describe("layoutTree: tidy, top-down", () => {
  const pos = layoutTree(tree);
  it("every active group gets a place, archived ones none", () => {
    expect([...pos.keys()].sort()).toEqual(["Ekonomi", "Kommunikation", "Ledning", "Utveckling", "VD"]);
  });
  it("arrows point down: every child is one row below its parent", () => {
    expect(pos.get("Ledning")!.y).toBe(pos.get("VD")!.y + CARD.height + CARD.gapY);
    expect(pos.get("Utveckling")!.y).toBe(pos.get("Ledning")!.y + CARD.height + CARD.gapY);
  });
  it("a parent is centred over its children, siblings in order without overlap", () => {
    const u = pos.get("Utveckling")!;
    const k = pos.get("Kommunikation")!;
    expect(k.x - u.x).toBe(CARD.width + CARD.gapX);
    expect(pos.get("Ledning")!.x).toBe((u.x + k.x) / 2);
    expect(pos.get("VD")!.x).toBe(pos.get("Ledning")!.x);
  });
  it("separate trees sit side by side, never overlapping", () => {
    expect(pos.get("Ekonomi")!.y).toBe(0);
    expect(pos.get("Ekonomi")!.x).toBeGreaterThanOrEqual(pos.get("Kommunikation")!.x + CARD.width);
  });
  it("is deterministic", () => {
    expect([...layoutTree([...tree].reverse())]).toEqual([...pos]);
  });
  it("no two cards overlap in a wide tree", () => {
    const wide = [g("R", null, 0), ...["a", "b", "c"].flatMap((x) => [g(x, "R", 1), g(`${x}1`, x, 2), g(`${x}2`, x, 2), g(`${x}3`, x, 2)])];
    const p = [...layoutTree(wide).values()];
    for (const a of p) for (const b of p) if (a !== b && a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(CARD.width);
  });
});

describe("canvasPositions", () => {
  it("no saved places: the layout", () => {
    expect(canvasPositions(tree)).toEqual(layoutTree(tree));
  });
  it("saved places win; unsaved cards go below what is placed", () => {
    const placed = tree.map((x) => (x.id === "Ekonomi" ? x : { ...x, canvas_x: 500, canvas_y: 40 }));
    const pos = canvasPositions(placed);
    expect(pos.get("VD")).toEqual({ x: 500, y: 40 });
    expect(pos.get("Ekonomi")!.y).toBeGreaterThanOrEqual(40 + CARD.height);
  });
  it("a new card's spot is right of everything", () => {
    expect(nextFreeSpot([{ x: 0, y: 10 }, { x: 300, y: 0 }])).toEqual({ x: 300 + CARD.width + CARD.gapX * 2, y: 0 });
    expect(nextFreeSpot([])).toEqual({ x: 0, y: 0 });
  });
});

describe("small helpers", () => {
  it("snap", () => {
    expect(snap(23, 16)).toBe(16);
    expect(snap(25, 16)).toBe(32);
  });
  it("initials", () => {
    expect(initials("Anna Berg")).toBe("AB");
    expect(initials("kim@example.se")).toBe("KI");
    expect(initials("Anna Maria Berg")).toBe("AB");
    expect(initials("")).toBe("?");
  });
});
