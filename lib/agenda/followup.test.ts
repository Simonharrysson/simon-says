import { describe, expect, it } from "vitest";
import type { NoteItemRow } from "@/lib/db/types";
import { carriedItems, openTasks } from "./followup";

const row = (o: Partial<NoteItemRow> & { id: string }): NoteItemRow => ({
  meeting_id: "m1",
  section: "action",
  text: "Gör något",
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: "Gör något",
  range_name: "r1",
  position: 0,
  kind: null,
  ...o,
});

const people = [
  { id: "p1", name: "Anna Lind", role: "Kassör" },
  { id: "p2", name: "Bo Ek", role: "Ordförande" },
  { id: "p3", name: "Cia Sjö", role: "Kassör" },
];

describe("openTasks", () => {
  it("keeps v1 action rows and kind=task rows", () => {
    const out = openTasks([row({ id: "n1" }), row({ id: "n2", section: "note", kind: "task" }), row({ id: "n9", section: "note" })]);
    expect(out.map((r) => r.id)).toEqual(["n1", "n2"]);
  });
  it("drops done, deleted, copies and -t ids", () => {
    const out = openTasks([
      row({ id: "n1", done: true }),
      row({ id: "n2", deleted_by_human: true }),
      row({ id: "n3-t", copy_of: "n3" }),
      row({ id: "n4-t" }),
      row({ id: "n5", copy_of: "n3" }),
      row({ id: "n6" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["n6"]);
  });
  it("a locked row keeps its human text and has no owner or due", () => {
    const [r] = openTasks([row({ id: "n1", locked: true, text: "Anna fixar kaffe", owner: "Anna", due: "fre" })]);
    expect(r.text).toBe("Anna fixar kaffe");
    expect(r.owner).toBeNull();
    expect(r.due).toBeNull();
  });
  it("orders by owner text then position", () => {
    const out = openTasks([
      row({ id: "a", owner: "Cia", position: 0 }),
      row({ id: "b", owner: "Anna", position: 2 }),
      row({ id: "c", owner: "Anna", position: 1 }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

describe("carriedItems", () => {
  const open = [
    row({ id: "n1", owner: "Bo", text: "Boka lokal", due: "fre", position: 0 }),
    row({ id: "n2", owner: "Anna", text: "Betala faktura", position: 1 }),
    row({ id: "n3", owner: "Cia", text: "Kolla kassan", position: 2 }),
    row({ id: "n4", owner: "Okänd", text: "Något", position: 3 }),
  ];
  it("groups by role: Kassör lines together, numbered c1.. in grouped order", () => {
    const out = carriedItems("M0", open, "f1", people);
    expect(out.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(out.map((r) => r.carried_from_id)).toEqual(["n2", "n3", "n4", "n1"]);
    expect(out.map((r) => r.position)).toEqual([0, 1, 2, 3]);
  });
  it("groups by person name", () => {
    const out = carriedItems("M0", open, "f1", people, "person");
    expect(out.map((r) => r.carried_from_id)).toEqual(["n2", "n1", "n3", "n4"]);
  });
  it("copies fields and sets carry metadata", () => {
    const out = carriedItems("M0", open, "f1", people);
    const r = out.find((x) => x.carried_from_id === "n1")!;
    expect(r).toMatchObject({
      meeting_id: "",
      section: "action",
      kind: "task",
      anchor: "f1",
      text: "Boka lokal",
      owner: "Bo",
      due: "fre",
      owner_person_id: "p2",
      carried_from_meeting: "M0",
      range_name: null,
      last_rendered_text: null,
    });
    expect(out.find((x) => x.carried_from_id === "n4")!.owner_person_id).toBeNull();
  });
});
