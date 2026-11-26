import { describe, expect, it } from "vitest";
import type { NoteItemRow } from "@/lib/db/types";
import { AGENDA_OPS_JSON_SCHEMA, OPS_JSON_SCHEMA, toAgendaOp, toNotesOp, type NotesItem } from "@/lib/notes/schema";
import { applyOps } from "@/lib/notes/engine";
import {
  applyTaskAnswers,
  incompleteTasks,
  isOverdue,
  markPlaceholders,
  meetingTasks,
  missingFields,
  parseTaskAnswers,
  resolveDue,
  taskMode,
  withDueDates,
} from "@/lib/notes/tasks";

const row = (over: Partial<NoteItemRow>): NoteItemRow => ({
  meeting_id: "m1",
  id: "n1",
  section: "action",
  kind: "task",
  text: "Boka lokal",
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: null,
  range_name: null,
  position: 0,
  ...over,
});

describe("extraction mapping: done_when", () => {
  it("both JSON schemas offer done_when", () => {
    expect(OPS_JSON_SCHEMA.properties.ops.items.properties).toHaveProperty("done_when");
    expect(AGENDA_OPS_JSON_SCHEMA.properties.ops.items.properties).toHaveProperty("done_when");
  });

  it("an add carries done_when as doneWhen, trimmed; missing or blank stays unset (never invented)", () => {
    expect(toNotesOp({ op: "add", id: "a", section: "action", text: "Boka lokal", owner: "Kassör", done_when: " kontraktet är påskrivet " })).toEqual({
      op: "add",
      item: { id: "a", section: "action", text: "Boka lokal", owner: "Kassör", doneWhen: "kontraktet är påskrivet" },
    });
    expect(toNotesOp({ op: "add", id: "a", section: "action", text: "Boka lokal" })).toEqual({
      op: "add",
      item: { id: "a", section: "action", text: "Boka lokal" },
    });
    const agenda = toAgendaOp({ op: "add", id: "a", kind: "task", anchor: "ag-2", text: "Boka lokal", done_when: "   " });
    expect(agenda).toEqual({ op: "add", item: { id: "a", section: "action", text: "Boka lokal", anchor: "ag-2" } });
  });

  it("a change may set or clear done_when alone", () => {
    expect(toNotesOp({ op: "change", id: "n1", done_when: "avtalet är påskrivet" })).toEqual({ op: "change", id: "n1", doneWhen: "avtalet är påskrivet" });
    expect(toAgendaOp({ op: "change", id: "n1", done_when: "" })).toEqual({ op: "change", id: "n1", doneWhen: "" });
  });

  it("applyOps sets done_when later on the same task (not a rewrite) and clears it with ''", () => {
    const items: NotesItem[] = [{ id: "n1", section: "action", text: "Boka lokal", owner: "Kassör" }];
    const set = applyOps(items, [{ op: "change", id: "n1", doneWhen: "kontraktet är påskrivet" }], { nextId: "n2" });
    expect(set.items).toEqual([{ id: "n1", section: "action", text: "Boka lokal", owner: "Kassör", doneWhen: "kontraktet är påskrivet" }]);
    const cleared = applyOps(set.items, [{ op: "change", id: "n1", doneWhen: "" }], { nextId: "n2" });
    expect(cleared.items[0]).not.toHaveProperty("doneWhen");
  });

  it("a carried task (Från förra veckan) takes no done_when", () => {
    const items: NotesItem[] = [{ id: "c1", section: "action", text: "Boka lokal", carried: true, anchor: "ag-1" }];
    expect(applyOps(items, [{ op: "change", id: "c1", doneWhen: "x" }]).dropped).toBe(1);
  });
});

describe("mode and missing fields", () => {
  it("föreningar require by default; the setting off suggests; other space kinds never force", () => {
    expect(taskMode({})).toBe("require");
    expect(taskMode({ require_task_fields: true })).toBe("require");
    expect(taskMode({ require_task_fields: false })).toBe("suggest");
    expect(taskMode({ require_task_fields: true, kind: "privat" })).toBe("suggest");
    expect(taskMode(null)).toBe("suggest");
  });

  it("missingFields lists what is not said", () => {
    expect(missingFields({ owner: "Kassör" })).toEqual(["due", "doneWhen"]);
    expect(missingFields({ owner: "Kassör", due: "fredag", doneWhen: "bokat" })).toEqual([]);
  });

  it("markPlaceholders marks open tasks only, and only in require mode", () => {
    const items: NotesItem[] = [
      { id: "n1", section: "action", text: "a" },
      { id: "n2", section: "action", text: "b", done: true },
      { id: "c1", section: "action", text: "c", carried: true },
      { id: "n3", section: "decision", text: "d" },
    ];
    expect(markPlaceholders(items, "require").map((i) => i.placeholders ?? false)).toEqual([true, false, false, false]);
    expect(markPlaceholders(items, "suggest")).toBe(items);
  });
});

describe("incomplete tasks (live panel, Avsluta dialog)", () => {
  it("this meeting's open primaries only: no copies, no carried, no deleted, no done (also through the copy)", () => {
    const rows = [
      row({ id: "n1", position: 1 }),
      row({ id: "n1-t", copy_of: "n1", anchor: "tasks" }),
      row({ id: "c1", carried_from_id: "n9", carried_from_meeting: "m0" }),
      row({ id: "n2", deleted_by_human: true }),
      row({ id: "n3", done: true }),
      row({ id: "n4", position: 2 }),
      row({ id: "n4-t", copy_of: "n4", done: true }),
      row({ id: "n5", position: 3, owner: "Kassör", due: "fredag", done_when: "bokat" }),
      row({ id: "n6", section: "decision", kind: "decision" }),
    ];
    expect(meetingTasks(rows).map((t) => t.id)).toEqual(["n3", "n1", "n4", "n5"]);
    expect(incompleteTasks(rows).map((t) => [t.id, t.missing])).toEqual([["n1", ["owner", "due", "doneWhen"]]]);
  });

  it("a human-edited (locked) task lacks only what its line still shows as a placeholder", () => {
    const filled = row({ id: "n1", locked: true, text: "☐ Kassör: Boka lokal (fredag) – klart när: kontrakt påskrivet" });
    const half = row({ id: "n2", locked: true, text: "☐ Kassör: Boka lokal (fredag) – (klart när?)" });
    expect(incompleteTasks([filled, half])).toEqual([
      expect.objectContaining({ id: "n2", missing: ["doneWhen"], locked: true }),
    ]);
  });
});

describe("Avsluta answers", () => {
  it("parse keeps our task ids with at least one field, cleaned and capped", () => {
    expect(
      parseTaskAnswers([
        { id: "n1", owner: " Kassör ", due: "fredag\n", doneWhen: "" },
        { id: "n1", owner: "twice" },
        { id: "c1", owner: "carried" },
        { id: "n2" },
        { id: "n3", doneWhen: "x".repeat(300) },
        "junk",
      ]),
    ).toEqual([
      { id: "n1", owner: "Kassör", due: "fredag" },
      { id: "n3", doneWhen: "x".repeat(200) },
    ]);
    expect(parseTaskAnswers(null)).toEqual([]);
  });

  it("apply: a person's answer replaces Claude's; other items untouched", () => {
    const items: NotesItem[] = [
      { id: "n1", section: "action", text: "Boka lokal", owner: "Anna", due: "snart" },
      { id: "n2", section: "decision", text: "Beslut" },
      { id: "c1", section: "action", text: "Gammal", carried: true },
    ];
    const out = applyTaskAnswers(items, [
      { id: "n1", due: "fredag", doneWhen: "kontraktet är påskrivet" },
      { id: "n2", owner: "x" },
      { id: "c1", owner: "x" },
    ]);
    expect(out).toEqual([
      { id: "n1", section: "action", text: "Boka lokal", owner: "Anna", due: "fredag", doneWhen: "kontraktet är påskrivet" },
      items[1],
      items[2],
    ]);
  });
});

describe("deadlines as days", () => {
  // Tuesday 2026-11-24, 18:00 in Stockholm.
  const meeting = "2026-11-24T17:00:00Z";
  it.each([
    ["2026-12-03", "2026-12-03"],
    ["3 dec", "2026-12-03"],
    ["den 3 december 2026", "2026-12-03"],
    ["3/12", "2026-12-03"],
    ["fredag", "2026-11-27"],
    ["på tisdag", "2026-12-01"],
    ["Friday", "2026-11-27"],
    ["imorgon", "2026-11-25"],
    ["15 januari", "2027-01-15"],
    ["till nästa möte", null],
    ["snart", null],
    ["", null],
    ["31 februari", null],
  ])("%s → %s", (due, day) => {
    expect(resolveDue(due, meeting)).toBe(day);
  });

  it("overdue: a day strictly before today", () => {
    expect(isOverdue("2026-11-27", "2026-12-01")).toBe(true);
    expect(isOverdue("2026-12-01", "2026-12-01")).toBe(false);
    expect(isOverdue(null, "2026-12-01")).toBe(false);
  });

  it("withDueDates resolves this meeting's tasks, keeps a carried task's own", () => {
    const rows = withDueDates(
      [
        row({ id: "n1", due: "fredag" }),
        row({ id: "c1", due: "fredag", due_date: "2026-11-20", carried_from_id: "n1", carried_from_meeting: "m0" }),
        row({ id: "n2", section: "decision", kind: "decision", due: null }),
      ],
      meeting,
    );
    expect(rows.map((r) => r.due_date ?? null)).toEqual(["2026-11-27", "2026-11-20", null]);
  });
});
