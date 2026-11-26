import { describe, expect, it } from "vitest";
import { carriedItems } from "@/lib/agenda/followup";
import type { NoteItemRow } from "@/lib/db/types";
import { skeletonRequests, skeletonTableFill } from "@/lib/docs/skeleton";
import { parseNotesTab } from "@/lib/docs/tab";
import { skeletonBlocks } from "@/lib/formats/skeleton";
import { ARSMOTE, VECKOMOTE } from "@/lib/formats/standard";
import type { FormatProfile } from "@/lib/formats/schema";
import { docOf, paraEl, TAB } from "@/test/docsim";
import { applyDoc, linesOf } from "@/test/formatdoc";
import { buildDraft, type DraftItem } from "./draft";
import { followupKey, itemText, planCarried, planInsert, planItemRanges, planReprepare, prepKey, prepMeeting, type DocLine } from "./doc";

const KEY = prepKey("p1");
const agenda = (doc: Parameters<typeof linesOf>[0]) => linesOf(doc).slice(linesOf(doc).indexOf("Agenda"), linesOf(doc).indexOf("Vad ska vi göra till nästa gång?"));
const people = [{ id: "p-anna", name: "Anna Berg", role: "Kassör" }];
const ownerLabel = (o: string) => (o.startsWith("Anna") ? "Kassör" : o);
const task = (id: string, text: string, owner: string): NoteItemRow =>
  ({ meeting_id: "m1", id, section: "action", kind: "task", text, owner, due: null, done: false, locked: false, deleted_by_human: false, position: 0 }) as NoteItemRow;
const OPEN = [task("n1", "Boka Kårallen", "Anna Berg"), task("n2", "Skicka kallelsen", "Erik")];

/** A new Doc as createFormatDoc writes it (docsim), then the prepare's own steps. */
function prepared(profile: FormatProfile, items: DraftItem[], carriedRows: NoteItemRow[]) {
  const doc = docOf([paraEl("")]);
  const on = items.filter((i) => i.on);
  const blocks = skeletonBlocks(profile, { items: on.map((i, n) => ({ label: i.label })) });
  applyDoc(doc, skeletonRequests(TAB, blocks, profile.numbering));
  applyDoc(doc, skeletonTableFill(parseNotesTab(doc, TAB), blocks));
  const ranged = planItemRanges(parseNotesTab(doc, TAB), profile, KEY, items);
  applyDoc(doc, ranged.requests);
  const rows = carry(doc, profile, ranged.lines, items, [], carriedRows, false);
  return { doc, lines: ranged.lines, rows };
}

function carry(doc: ReturnType<typeof docOf>, profile: FormatProfile, lines: DocLine[], items: DraftItem[], stored: NoteItemRow[], desired: NoteItemRow[], rewritten: boolean) {
  const tab = parseNotesTab(doc, TAB);
  const fk = followupKey(tab, lines, items);
  const meeting = prepMeeting(KEY, "doc", TAB, lines, items);
  const want = fk ? desired.map((r) => ({ ...r, anchor: fk })) : [];
  const { plan, rows } = planCarried(tab, meeting, stored, want, { profile, ownerLabel, rewritten });
  applyDoc(doc, plan.requests);
  return rows;
}

describe("prepared agenda Doc", () => {
  const draft = buildDraft({ profile: VECKOMOTE, carried: carriedItems("m1", OPEN, "followup", people), ctx: { profile: VECKOMOTE, ownerLabel }, topics: [{ label: "Sponsring", meetings: 2 }] });
  const desired = carriedItems("m1", OPEN, "followup", people);

  it("Veckomöte: items as a numbered list with our ranges; Från förra veckan lists the open tasks as engine lines", () => {
    const { doc, lines, rows } = prepared(VECKOMOTE, draft, desired);
    expect(linesOf(doc).slice(linesOf(doc).indexOf("Agenda"))).toEqual([
      "Agenda",
      "Godkänn dagordning",
      "Må-runda",
      "Från förra veckan",
      "– Erik: Skicka kallelsen.",
      "– Kassör: Boka Kårallen.",
      "Övrigt",
      "Vad ska vi göra till nästa gång?",
      "Anteckningar",
    ]);
    expect(lines.map((l) => [l.id, l.range, l.text])).toEqual([
      ["std:approve", "ss-prep-p1-ag-1", "Godkänn dagordning"],
      ["std:checkin", "ss-prep-p1-ag-2", "Må-runda"],
      ["std:followup", "ss-prep-p1-ag-3", "Från förra veckan"],
      ["std:other", "ss-prep-p1-ag-4", "Övrigt"],
    ]);
    expect(rows.map((r) => [r.id, r.range_name, r.last_rendered_text, r.carried_from_meeting, r.carried_from_id])).toEqual([
      ["c1", "ss-prep-p1-c1", "– Erik: Skicka kallelsen.", "m1", "n2"],
      ["c2", "ss-prep-p1-c2", "– Kassör: Boka Kårallen.", "m1", "n1"],
    ]);
  });

  it("Årsmöte: § items as headings", () => {
    const items = buildDraft({ profile: ARSMOTE, carried: [], ctx: { profile: ARSMOTE, ownerLabel }, topics: [] });
    const { doc, lines } = prepared(ARSMOTE, items, []);
    expect(lines[0].text).toBe("§1 Mötets öppnande");
    expect(linesOf(doc)).toContain("§13 Mötets avslutande");
  });

  it("preparing again with no human edits rewrites the agenda in the new order; the carried lines come back once", () => {
    const { doc, lines, rows } = prepared(VECKOMOTE, draft, desired);
    const next: DraftItem[] = [
      draft[0],
      { id: "add:fest", label: "Fest på universitetet", role: "topic", source: "added", on: true },
      draft[2],
      { ...draft[3], on: true },
      draft[4],
    ];
    const plan = planReprepare(parseNotesTab(doc, TAB), VECKOMOTE, KEY, lines, rows, next);
    expect(plan.mode).toBe("rewrite");
    applyDoc(doc, plan.requests);
    const again = carry(doc, VECKOMOTE, plan.lines, next, rows, desired, true);
    expect(linesOf(doc).slice(linesOf(doc).indexOf("Agenda"), linesOf(doc).indexOf("Vad ska vi göra till nästa gång?"))).toEqual([
      "Agenda",
      "Godkänn dagordning",
      "Fest på universitetet",
      "Från förra veckan",
      "– Erik: Skicka kallelsen.",
      "– Kassör: Boka Kårallen.",
      "Sponsring",
      "Övrigt",
    ]);
    expect(again.map((r) => r.range_name)).toEqual(["ss-prep-p1-c3", "ss-prep-p1-c4"]);
    const tab = parseNotesTab(doc, TAB);
    expect(tab.paragraphs.find((p) => p.text === "Fest på universitetet\n")?.bullet?.level).toBe(0);
  });

  it("preparing again after a human only deleted a line: merge, the line is not written back", () => {
    const { doc, lines, rows } = prepared(VECKOMOTE, draft, desired);
    const mr = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: mr.start, endIndex: mr.end } } }]);
    const erik = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text.startsWith("– Erik"))!;
    applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: erik.start, endIndex: erik.end } } }]);
    const plan = planReprepare(parseNotesTab(doc, TAB), VECKOMOTE, KEY, lines, rows, draft);
    expect(plan.mode).toBe("merge");
    applyDoc(doc, plan.requests);
    carry(doc, VECKOMOTE, plan.lines, draft, rows, desired, false);
    expect(agenda(doc)).toEqual(["Agenda", "Godkänn dagordning", "Från förra veckan", "– Kassör: Boka Kårallen.", "Övrigt"]);
  });

  it("preparing again after human edits: their lines win, ours change in place, a new item is inserted before the next one of the draft", () => {
    const { doc, lines, rows } = prepared(VECKOMOTE, draft, desired);
    // A human renames "Må-runda" and deletes the Erik line in the Doc.
    const tab0 = parseNotesTab(doc, TAB);
    const mr = tab0.paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: " (kort)", location: { tabId: TAB, index: mr.end - 1 } } }]);
    const erik = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text.startsWith("– Erik"))!;
    applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: erik.start, endIndex: erik.end } } }]);

    const next: DraftItem[] = [
      { ...draft[0], label: "Godkänn dagordningen" },
      { ...draft[1], label: "Hur mår vi" },
      { id: "add:fest", label: "Fest på universitetet", role: "topic", source: "added", on: true },
      draft[2],
      draft[4],
    ];
    const plan = planReprepare(parseNotesTab(doc, TAB), VECKOMOTE, KEY, lines, rows, next);
    expect(plan.mode).toBe("merge");
    expect(plan.inserts).toEqual(["add:fest"]);
    applyDoc(doc, plan.requests);
    let current = plan.lines;
    for (const id of plan.inserts) {
      const ins = planInsert(parseNotesTab(doc, TAB), VECKOMOTE, KEY, current, next, id)!;
      applyDoc(doc, ins.requests);
      current = [...current, ins.line];
    }
    const kept = carry(doc, VECKOMOTE, current, next, rows, desired, false);
    expect(linesOf(doc).slice(linesOf(doc).indexOf("Agenda"), linesOf(doc).indexOf("Vad ska vi göra till nästa gång?"))).toEqual([
      "Agenda",
      "Godkänn dagordningen",
      "Må-runda (kort)",
      "Fest på universitetet",
      "Från förra veckan",
      "– Kassör: Boka Kårallen.",
      "Övrigt",
    ]);
    // Erik's task was deleted by a human: kept as deleted, never written again.
    expect(kept.find((r) => r.carried_from_id === "n2")?.deleted_by_human).toBe(true);
    expect(kept.find((r) => r.carried_from_id === "n1")?.range_name).toBe("ss-prep-p1-c2");
    expect(itemText(VECKOMOTE, "x", 3)).toBe("x");
  });
});
