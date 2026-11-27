import { describe, expect, it } from "vitest";
import { hasOwnNotes, isEmptySummary, MAX_DECISIONS, summaryContent, type SummaryItem } from "./content";

let pos = 0;
const item = (over: Partial<SummaryItem> & Pick<SummaryItem, "id" | "section" | "text">): SummaryItem => ({
  owner: null,
  due: null,
  position: pos++,
  ...over,
});

const people = [
  { id: "p-anna", name: "Anna Berg", role: "Kassör" },
  { id: "p-erik", name: "Erik Lund", role: null },
];

describe("summaryContent", () => {
  const items: SummaryItem[] = [
    item({ id: "n1", section: "decision", kind: "decision", text: "Hackathon 14 feb, budget 8 000 kr" }),
    item({ id: "n2", section: "action", kind: "task", text: "Boka lokal", owner: "Erik", due: "fre" }),
    item({ id: "n3", section: "action", kind: "task", text: "Betala hyran", owner: "kassören" }),
    item({ id: "n4", section: "action", kind: "task", text: "Skicka kallelse", owner: "Anna", owner_person_id: "p-anna" }),
    item({ id: "n4-t", section: "action", kind: "task", text: "Skicka kallelse", copy_of: "n4" }),
    item({ id: "n5", section: "action", kind: "task", text: "Klar sak", done: true }),
    item({ id: "n6", section: "note", kind: "note", text: "Sponsorerna hör av sig i januari" }),
    item({ id: "n7", section: "note", kind: "note", text: "Mår bra, lite trött", anchor: "ag-1" }),
    item({ id: "n8", section: "note", kind: "note", text: "18:05–19:10", anchor: "info.tid" }),
    item({ id: "n9", section: "decision", kind: "decision", text: "Struket beslut", deleted_by_human: true }),
    item({ id: "n10", section: "now", kind: "now", text: "Diskussion om sponsorer" }),
    item({ id: "n11", section: "attendees", kind: "attendee", text: "Anna" }),
  ];
  const roles = { "ag-1": "checkin" as const };

  it("decisions, open tasks and other notes; no Må-runda, info cells, copies, done or deleted rows", () => {
    const c = summaryContent(items, { agendaRoles: roles, people });
    expect(c.decisions).toEqual(["Hackathon 14 feb, budget 8 000 kr"]);
    expect(c.tasks.map((t) => t.text)).toEqual(["Boka lokal", "Betala hyran", "Skicka kallelse"]);
    expect(c.other).toEqual(["Sponsorerna hör av sig i januari"]);
    expect(isEmptySummary(c)).toBe(false);
  });

  it("the recipient's own tasks come first: by owner id, name or role", () => {
    const c = summaryContent(items, { agendaRoles: roles, people, forPerson: { id: "p-anna" } });
    expect(c.tasks.map((t) => [t.text, t.mine])).toEqual([
      ["Betala hyran", true],
      ["Skicka kallelse", true],
      ["Boka lokal", false],
    ]);
  });

  it("a task done through its tasks copy is left out", () => {
    const c = summaryContent([item({ id: "a", section: "action", kind: "task", text: "X" }), item({ id: "a-t", section: "action", kind: "task", text: "X", copy_of: "a", done: true })]);
    expect(c.tasks).toEqual([]);
  });

  it("caps each list and counts the rest", () => {
    const many = Array.from({ length: MAX_DECISIONS + 3 }, (_, i) => item({ id: `d${i}`, section: "decision", kind: "decision", text: `Beslut ${i}` }));
    const c = summaryContent(many);
    expect(c.decisions).toHaveLength(MAX_DECISIONS);
    expect(c.more.decisions).toBe(3);
  });

  it("nothing but Närvarande and 'Pågår nu' is empty", () => {
    expect(isEmptySummary(summaryContent([items[10], items[11]]))).toBe(true);
  });

  it("Övrigt skips notes under procedural and follow-up items", () => {
    const c = summaryContent(
      [
        item({ id: "o1", section: "note", kind: "note", text: "Mötet öppnades 18.05", anchor: "ag-0" }),
        item({ id: "o2", section: "note", kind: "note", text: "Förra protokollet lades till handlingarna", anchor: "ag-2" }),
        item({ id: "o3", section: "note", kind: "note", text: "Kåren bjuder på fika", anchor: "ag-9" }),
      ],
      { agendaRoles: { "ag-0": "procedural", "ag-2": "followup", "ag-9": "other" } },
    );
    expect(c.other).toEqual(["Kåren bjuder på fika"]);
  });

  it("tasks carried in from the last meeting are shown, but alone they are no notes", () => {
    const carried = item({ id: "c1", section: "action", kind: "task", text: "Gammal uppgift", carried_from_id: "n3", carried_from_meeting: "m0" });
    expect(summaryContent([carried]).tasks.map((t) => t.text)).toEqual(["Gammal uppgift"]);
    expect(hasOwnNotes([carried])).toBe(false);
    expect(hasOwnNotes([carried, item({ id: "d", section: "decision", kind: "decision", text: "Nytt beslut" })])).toBe(true);
  });

  it("legacy rows without kind still count by section", () => {
    const c = summaryContent([item({ id: "l1", section: "decision", text: "Gammalt beslut" }), item({ id: "l2", section: "action", text: "Gammal uppgift" })]);
    expect([c.decisions, c.tasks.map((t) => t.text)]).toEqual([["Gammalt beslut"], ["Gammal uppgift"]]);
  });
});

describe("concrete tasks in the summary (0049)", () => {
  const rows: SummaryItem[] = [
    item({ id: "n1", section: "action", kind: "task", text: "Boka lokal", owner: "Erik", due: "fredag", due_date: "2026-11-27", done_when: "kontraktet är påskrivet" }),
    item({ id: "n2", section: "action", kind: "task", text: "Betala hyran", owner: "Kassör" }),
    item({ id: "n3", section: "action", kind: "task", text: "☐ Anna: Ringa (måndag) – (klart när?)", locked: true }),
    item({ id: "c1", section: "action", kind: "task", text: "Gammal uppgift", carried_from_id: "n9", carried_from_meeting: "m0" }),
  ];

  it("deadline, Klart när and overdue (deadline day before the e-mail's day)", () => {
    const [boka] = summaryContent(rows, { today: "2026-12-01" }).tasks;
    expect(boka).toMatchObject({ due: "fredag", doneWhen: "kontraktet är påskrivet", overdue: true, missing: [] });
    expect(summaryContent(rows, { today: "2026-11-27" }).tasks[0].overdue).toBe(false);
  });

  it("what each task lacks, only when the förening requires it (a locked line: its placeholders)", () => {
    // A carried task (Från förra veckan) is never nagged about: nothing in this meeting completes it.
    expect(summaryContent(rows, { requireFields: true }).tasks.map((t) => t.missing)).toEqual([[], ["due", "doneWhen"], ["doneWhen"], []]);
    expect(summaryContent(rows).tasks.map((t) => t.missing)).toEqual([[], [], [], []]);
    // The locked line's text has no placeholders in the e-mail.
    expect(summaryContent(rows).tasks[2].text).toBe("☐ Anna: Ringa (måndag)");
  });
});
