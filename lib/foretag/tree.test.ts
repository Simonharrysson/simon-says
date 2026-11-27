import { describe, expect, it } from "vitest";
import { hasTree, parentChoices, seenByGroups, treeRows, type GroupRow } from "./tree";

const g = (id: string, parent: string | null, depth: number, position = 0, archived = false): GroupRow => ({
  id,
  name: id,
  parent_group_id: parent,
  depth,
  position,
  archived_at: archived ? "2026-11-27" : null,
});
const groups = [g("Utveckling", "Ledning", 2, 0), g("VD", null, 0), g("Kommunikation", "Ledning", 2, 1), g("Ledning", "VD", 1), g("Gammal", "VD", 1, 5, true)];

describe("treeRows", () => {
  it("depth-first, parents before children, archived left out", () => {
    expect(treeRows(groups).map((r) => `${r.depth}:${r.group.id}`)).toEqual(["0:VD", "1:Ledning", "2:Utveckling", "2:Kommunikation"]);
  });
  it("a group under an archived parent shows as a root", () => {
    const rows = treeRows([g("A", null, 0, 0, true), g("B", "A", 1)]);
    expect(rows.map((r) => `${r.depth}:${r.group.id}`)).toEqual(["0:B"]);
  });
});

describe("parentChoices", () => {
  it("never itself or its descendants", () => {
    expect(parentChoices(groups, "Ledning").map((x) => x.id)).toEqual(["VD"]);
    expect(parentChoices(groups, "Utveckling").map((x) => x.id).sort()).toEqual(["Kommunikation", "Ledning", "VD"]);
  });
});

describe("seenByGroups", () => {
  it("the groups above a group's level", () => {
    expect(seenByGroups(groups, groups[0]).map((x) => x.id).sort()).toEqual(["Ledning", "VD"]);
  });
});

describe("hasTree", () => {
  it("a Företag always; a förening only with groups turned on; never Privat", () => {
    expect(hasTree({ kind: "foretag" })).toBe(true);
    expect(hasTree({ kind: "forening", groups_enabled: true })).toBe(true);
    expect(hasTree({ kind: "forening", groups_enabled: false })).toBe(false);
    // A row read before 0054 (no column) or before 0045 (no kind): a plain förening.
    expect(hasTree({ kind: "forening" })).toBe(false);
    expect(hasTree({})).toBe(false);
    expect(hasTree(null)).toBe(false);
    expect(hasTree({ kind: "privat" })).toBe(false);
  });
});
