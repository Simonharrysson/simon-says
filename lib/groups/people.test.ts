import { describe, expect, it } from "vitest";
import type { GroupRow } from "@/lib/foretag/tree";
import { connectCheck, layoutTree } from "./canvas";
import { asTreeRows, peopleTree } from "./people";
import { labelTeams, ownerOf } from "./teams";

// Simon at the top (group T); Adam and Eva in Simons team (S, head Simon); Bo in Adams team (A).
const groups: GroupRow[] = [
  { id: "T", name: "top", parent_group_id: null, depth: 0, position: 0 },
  { id: "S", name: "team s", parent_group_id: "T", depth: 1, position: 0, head_person_id: "simon" },
  { id: "A", name: "team a", parent_group_id: "S", depth: 2, position: 0, head_person_id: "adam" },
  { id: "X", name: "old", parent_group_id: "T", depth: 1, position: 0, archived_at: "2026-11-27" },
];
const people = [
  { id: "simon", name: "Simon Berg", member_user_id: "u1", group_id: "T" },
  { id: "adam", name: "Adam", member_user_id: null, group_id: "S" },
  { id: "eva", name: "Eva", member_user_id: null, group_id: "S", role: "Kassör" },
  { id: "bo", name: "Bo", member_user_id: "u2", group_id: "A" },
  { id: "olle", name: "Olle", member_user_id: null, group_id: "X" },
];
const members = [
  { userId: "u1", email: "simon@x.se", role: "admin" as const },
  { userId: "u2", email: "bo@x.se", role: "member" as const },
  { userId: "u3", email: "ny@x.se", role: "member" as const },
];

describe("peopleTree: managers read from the groups", () => {
  const tree = peopleTree(people, groups, members, "u2");
  const by = (k: string) => tree.find((p) => p.key === k)!;
  it("the head of your group is your manager; the top group means none", () => {
    expect(by("p:simon")).toMatchObject({ placed: true, managerId: null, admin: true, email: "simon@x.se" });
    expect(by("p:adam")).toMatchObject({ placed: true, managerId: "simon" });
    expect(by("p:eva")).toMatchObject({ managerId: "simon", role: "Kassör" });
    expect(by("p:bo")).toMatchObject({ managerId: "adam", you: true });
  });
  it("an archived group or none: outside the tree; accounts without a row too", () => {
    expect(by("p:olle")).toMatchObject({ placed: false, managerId: null });
    expect(by("u:u3")).toMatchObject({ placed: false, personId: null, name: "ny@x.se" });
  });
  it("as tree rows: one parent per person, depth by reporting line", () => {
    const rows = asTreeRows(tree);
    expect(rows.map((r) => `${r.id}<${r.parent_group_id ?? "-"}:${r.depth}`).sort()).toEqual(["adam<simon:1", "bo<adam:2", "eva<simon:1", "simon<-:0"]);
    // Arrows point down: never a manager under their own report.
    expect(connectCheck(rows, "bo", "simon")).toEqual({ ok: false, reason: "cycle" });
    expect(connectCheck(rows, "eva", "bo")).toEqual({ ok: true, replaces: "adam" });
    // The layout puts reports one row below their manager.
    const pos = layoutTree(rows);
    expect(pos.get("bo")!.y).toBeGreaterThan(pos.get("adam")!.y);
    expect(pos.get("adam")!.y).toBeGreaterThan(pos.get("simon")!.y);
  });
});

describe("teams: never a group name", () => {
  it("genitive of the first name", () => {
    expect(ownerOf("Simon Berg", "sv")).toBe("Simons");
    expect(ownerOf("Jonas", "sv")).toBe("Jonas");
    expect(ownerOf("Simon", "en")).toBe("Simon's");
    expect(ownerOf("Jonas", "en")).toBe("Jonas'");
  });
  it("a group shows as its head's team, the top as the top (a headless group from before 0062 keeps its name)", () => {
    const words = { team: (o: string) => `${o} team`, top: "Högst upp" };
    const out = labelTeams(groups, new Map([["simon", "Simon Berg"], ["adam", "Adam"]]), words, "sv");
    expect(out.map((g) => g.name)).toEqual(["Högst upp", "Simons team", "Adams team", "old"]);
  });
});
