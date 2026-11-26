import { describe, expect, it } from "vitest";
import { isEmptySummary, MAX_DECISIONS, summaryContent, type SummaryItem } from "./content";

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

  it("legacy rows without kind still count by section", () => {
    const c = summaryContent([item({ id: "l1", section: "decision", text: "Gammalt beslut" }), item({ id: "l2", section: "action", text: "Gammal uppgift" })]);
    expect([c.decisions, c.tasks.map((t) => t.text)]).toEqual([["Gammalt beslut"], ["Gammal uppgift"]]);
  });
});
