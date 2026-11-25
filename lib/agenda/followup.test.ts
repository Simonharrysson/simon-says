import { describe, expect, it } from "vitest";
import type { NoteItemRow } from "@/lib/db/types";
import { carriedItems, carryPlan, openTasks, propagateDone } from "./followup";

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
    const out = openTasks([
      row({ id: "n1" }),
      row({ id: "n2", section: "note", kind: "task" }),
      row({ id: "n9", section: "note" }),
    ]);
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
    const [r] = openTasks([
      row({
        id: "n1",
        locked: true,
        text: "Anna fixar kaffe",
        owner: "Anna",
        due: "fre",
      }),
    ]);
    expect(r.text).toBe("Anna fixar kaffe");
    expect(r.owner).toBeNull();
    expect(r.due).toBeNull();
  });
  it("sorts a null owner first", () => {
    const out = openTasks([
      row({ id: "a", owner: "Anna" }),
      row({ id: "b", owner: null }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
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
  it("a locked source row carries no owner_person_id", () => {
    const locked = openTasks([
      row({ id: "n1", locked: true, owner: "Anna", text: "Anna fixar" }),
    ]);
    expect(
      carriedItems("M0", locked, "f1", people)[0].owner_person_id,
    ).toBeNull();
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
    expect(
      out.find((x) => x.carried_from_id === "n4")!.owner_person_id,
    ).toBeNull();
  });
});

describe("openTasks: done through the tasks copy (final review R2-I3)", () => {
  it("a locked primary whose -t copy is done is not open", () => {
    const out = openTasks([
      row({ id: "n1", locked: true }),
      row({ id: "n1-t", copy_of: "n1", done: true }),
      row({ id: "n2", locked: true }),
      row({ id: "n2-t", copy_of: "n2" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["n2"]);
  });

  it("orders n2 before n10 (numeric)", () => {
    expect(openTasks([row({ id: "n10", owner: "n10" }), row({ id: "n2", owner: "n2" })]).map((r) => r.id)).toEqual(["n2", "n10"]);
  });
});

describe("carryPlan: a false start on the same Doc (final review R1/R2)", () => {
  const carried = (id: string, from: string, src: string, o: Partial<NoteItemRow> = {}) =>
    row({ id, meeting_id: "A", range_name: `ss-A-${id}`, carried_from_meeting: from, carried_from_id: src, kind: "task", ...o });
  const intact = (names: string[]) => (n: string) => names.includes(n);

  it("week 1 → false start A (same Doc as B) → B → C: each open task carried once, the chain kept", () => {
    const week1 = [row({ id: "n1", meeting_id: "W1" }), row({ id: "n2", meeting_id: "W1" })];
    // A is abandoned: never `prev`; its lines c1 (n1) and c2 (n2) are in the Doc, c2 removed by a human since.
    const a = [carried("c1", "W1", "n1"), carried("c2", "W1", "n2")];
    const b = carryPlan({ prev: { id: "W1", rows: week1 }, sameDoc: { id: "A", rows: a }, intact: intact(["ss-A-c1"]) });
    expect(b.adopted.map((r) => r.id)).toEqual(["c1"]);
    expect(b.open.map((r) => r.id)).toEqual(["n2"]);
    // B's rows after its start: c1 taken over (range ss-A-c1), c2 fresh. C (another Doc) carries both.
    const bRows = [{ ...b.adopted[0], meeting_id: "B" }, carried("c2", "W1", "n2", { meeting_id: "B", range_name: "ss-B-c2" })];
    const c = carryPlan({ prev: { id: "B", rows: bRows }, sameDoc: null, intact: () => true });
    expect(c.adopted).toEqual([]);
    expect(c.open.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("A was the previous (done) meeting on the same Doc: its intact carried rows are adopted, not re-carried", () => {
    const a = [carried("c1", "W1", "n1"), row({ id: "n5", meeting_id: "A" })];
    const b = carryPlan({ prev: { id: "A", rows: a }, sameDoc: { id: "A", rows: a }, intact: intact(["ss-A-c1"]) });
    expect(b.adopted.map((r) => r.id)).toEqual(["c1"]);
    expect(b.open.map((r) => r.id)).toEqual(["n5"]);
  });

  it("a Doc cleared for a new week (lines gone): the open carried tasks are carried again", () => {
    const prev = [carried("c1", "W0", "n1", { meeting_id: "W1", range_name: "ss-W1-c1" })];
    const b = carryPlan({ prev: { id: "W1", rows: prev }, sameDoc: { id: "W1", rows: prev }, intact: () => false });
    expect(b.adopted).toEqual([]);
    expect(b.open.map((r) => r.id)).toEqual(["c1"]);
  });
});

describe("propagateDone through a tasks copy (final review N3)", () => {
  /** A PostgREST stand-in: the source meeting exists; records which source ids are set done. */
  function fakeDb(updated: string[][]) {
    const chain = (table: string, op: "select" | "update") => {
      let ids: string[] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: (col: string, v: string[]) => ((col === "id" ? (ids = v) : null), b),
        then: (res: (v: unknown) => unknown) => {
          if (table === "meetings") return res({ data: [{ id: "W1" }], error: null });
          if (op === "update") updated.push(ids);
          return res({ data: ids.map((id) => ({ id })), error: null });
        },
      };
      return b;
    };
    return { from: (table: string) => ({ select: () => chain(table, "select"), update: () => chain(table, "update") }) } as never;
  }

  it("done set on the -t copy reaches the primary's source row", async () => {
    const updated: string[][] = [];
    const rows = [
      row({ id: "c1", locked: true, carried_from_meeting: "W1", carried_from_id: "n4" }),
      row({ id: "c1-t", copy_of: "c1", done: true }),
    ];
    expect(await propagateDone(rows, "org", false, fakeDb(updated))).toBe(1);
    expect(updated).toEqual([["n4"]]);
  });
});
