import { describe, expect, it } from "vitest";
import type { NoteItemRow } from "@/lib/db/types";
import { itemRangeName, parseNotesTab } from "@/lib/docs/notes";
import { paragraphsWithRanges } from "@/lib/google/docs";
import { apply, docOf, paraEl, TAB } from "@/test/docsim";
import { planDocDone } from "./doc-done";

const M = "m1";
const row = (id: string, line: string, over: Partial<NoteItemRow> = {}): NoteItemRow => ({
  meeting_id: M,
  id,
  section: "action",
  kind: "task",
  text: line,
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: line,
  range_name: itemRangeName(M, id),
  position: 0,
  ...over,
});

/** A Doc with a heading and our lines (each with its named range). */
function docWith(lines: { id: string; text: string }[]) {
  const doc = docOf([paraEl("Uppgifter", { style: "HEADING_2" })]);
  const end = doc.tabs![0].documentTab!.body!.content!.at(-1)!.endIndex!;
  // A new paragraph after the heading, then our lines in it (one named range each).
  apply(doc, [{ insertText: { text: "\n", location: { index: end - 1, tabId: TAB } } }]);
  return apply(doc, paragraphsWithRanges(TAB, end, lines.map((l) => ({ name: itemRangeName(M, l.id), text: l.text }))));
}

const textOf = (doc: ReturnType<typeof docOf>) => parseNotesTab(doc, TAB).paragraphs.map((p) => p.text.replace(/\n$/, ""));

describe("planDocDone: ✓ klart on our own lines only", () => {
  it("appends ✓ klart to the task's line and its tasks copy", () => {
    const lines = [
      { id: "n1", text: "Simon: Boka lokal (fredag)." },
      { id: "n1-t", text: "Simon: Boka lokal (fredag)." },
    ];
    const doc = docWith(lines);
    const tab = parseNotesTab(doc, TAB);
    const plan = planDocDone(tab, TAB, [row("n1", lines[0].text), row("n1-t", lines[1].text, { copy_of: "n1" })]);
    expect(plan.primaryDone).toBe(true);
    expect(plan.written).toEqual([
      { id: "n1", text: "Simon: Boka lokal (fredag). ✓ klart" },
      { id: "n1-t", text: "Simon: Boka lokal (fredag). ✓ klart" },
    ]);
    expect(plan.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: itemRangeName(M, "n1"), text: "Simon: Boka lokal (fredag). ✓ klart", tabsCriteria: { tabIds: [TAB] } } },
      { replaceNamedRangeContent: { namedRangeName: itemRangeName(M, "n1-t"), text: "Simon: Boka lokal (fredag). ✓ klart", tabsCriteria: { tabIds: [TAB] } } },
    ]);
    // Written already (e.g. a retry, the line now says klart): nothing more.
    const after = docWith([{ id: "n1", text: "Simon: Boka lokal (fredag). ✓ klart" }]);
    expect(textOf(after)).toContain("Simon: Boka lokal (fredag). ✓ klart");
    const again = planDocDone(parseNotesTab(after, TAB), TAB, [row("n1", "Simon: Boka lokal (fredag). ✓ klart")]);
    expect(again).toEqual({ requests: [], written: [], primaryDone: true });
  });

  it("a line a human edited is theirs: not written, and the person is asked to tick it in the Doc", () => {
    const doc = docWith([{ id: "n1", text: "Simon: Boka lokal (fredag) – ring Kårallen." }]);
    const plan = planDocDone(parseNotesTab(doc, TAB), TAB, [row("n1", "Simon: Boka lokal (fredag).")]);
    expect(plan).toEqual({ requests: [], written: [], primaryDone: false });
  });

  it("a locked row, a deleted line or a never-written row: not written", () => {
    const doc = docWith([{ id: "n1", text: "Simon: Boka lokal." }]);
    const tab = parseNotesTab(doc, TAB);
    expect(planDocDone(tab, TAB, [row("n1", "Simon: Boka lokal.", { locked: true })]).primaryDone).toBe(false);
    expect(planDocDone(tab, TAB, [row("n2", "Gone.")]).primaryDone).toBe(false);
    expect(planDocDone(tab, TAB, [row("n1", "Simon: Boka lokal.", { range_name: null })]).primaryDone).toBe(false);
  });

  it("the copy is written even when the primary is the human's", () => {
    const doc = docWith([
      { id: "n1", text: "Simon: Boka lokal, ändrad." },
      { id: "n1-t", text: "Simon: Boka lokal." },
    ]);
    const plan = planDocDone(parseNotesTab(doc, TAB), TAB, [row("n1", "Simon: Boka lokal."), row("n1-t", "Simon: Boka lokal.", { copy_of: "n1" })]);
    expect(plan.primaryDone).toBe(false);
    expect(plan.written).toEqual([{ id: "n1-t", text: "Simon: Boka lokal. ✓ klart" }]);
  });
});
