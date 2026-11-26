import { describe, expect, it } from "vitest";
import { carriedItems } from "@/lib/agenda/followup";
import type { NoteItemRow } from "@/lib/db/types";
import { skeletonRequests, skeletonTableFill } from "@/lib/docs/skeleton";
import { parseNotesTab, type NotesTab } from "@/lib/docs/tab";
import { skeletonBlocks } from "@/lib/formats/skeleton";
import { VECKOMOTE } from "@/lib/formats/standard";
import type { DocsRequest } from "@/lib/google/docs";
import { docOf, paraEl, TAB } from "@/test/docsim";
import { applyDoc, linesOf } from "@/test/formatdoc";
import { followupKey, planCarried, planInsert, planItemRanges, planReprepare, prepKey, prepMeeting, type DocLine } from "./doc";
import { buildDraft, type DraftItem } from "./draft";
import { runReprepare, type ReprepareDeps } from "./reprepare";

const KEY = prepKey("p1");
const people = [{ id: "p-anna", name: "Anna Berg", role: "Kassör" }];
const ownerLabel = (o: string) => (o.startsWith("Anna") ? "Kassör" : o);
const task = (id: string, text: string, owner: string): NoteItemRow =>
  ({ meeting_id: "m1", id, section: "action", kind: "task", text, owner, due: null, done: false, locked: false, deleted_by_human: false, position: 0 }) as NoteItemRow;
const desired = carriedItems("m1", [task("n1", "Boka Kårallen", "Anna Berg"), task("n2", "Skicka kallelsen", "Erik")], "followup", people);
const draft = buildDraft({ profile: VECKOMOTE, carried: desired, ctx: { profile: VECKOMOTE, ownerLabel }, topics: [] });
const FEST: DraftItem = { id: "add:fest", label: "Fest på universitetet", role: "topic", source: "added", on: true };
const agenda = (doc: ReturnType<typeof docOf>) => linesOf(doc).slice(linesOf(doc).indexOf("Agenda"), linesOf(doc).indexOf("Vad ska vi göra till nästa gång?"));

function prepared() {
  const doc = docOf([paraEl("")]);
  const blocks = skeletonBlocks(VECKOMOTE, { items: draft.filter((i) => i.on).map((i) => ({ label: i.label })) });
  applyDoc(doc, skeletonRequests(TAB, blocks, VECKOMOTE.numbering));
  applyDoc(doc, skeletonTableFill(parseNotesTab(doc, TAB), blocks));
  const ranged = planItemRanges(parseNotesTab(doc, TAB), VECKOMOTE, KEY, draft);
  applyDoc(doc, ranged.requests);
  const tab = parseNotesTab(doc, TAB);
  const fk = followupKey(tab, ranged.lines, draft)!;
  const { plan, rows } = planCarried(tab, prepMeeting(KEY, "doc", TAB, ranged.lines, draft), [], desired.map((r) => ({ ...r, anchor: fk })), {
    profile: VECKOMOTE,
    ownerLabel,
    rewritten: false,
  });
  applyDoc(doc, plan.requests);
  return { doc, store: { lines: ranged.lines as DocLine[], carried: rows } };
}

/** Deps on a docsim Doc: the n-th step's write or the n-th save may fail (after the write went through). */
function deps(doc: ReturnType<typeof docOf>, store: { lines: DocLine[]; carried: NoteItemRow[] }, fail: { step?: number; save?: number } = {}): ReprepareDeps {
  let steps = 0;
  let saves = 0;
  return {
    async step<T>(plan: (tab: NotesTab) => { requests: DocsRequest[]; value: T }) {
      const p = plan(parseNotesTab(doc, TAB));
      if (++steps === fail.step) throw new Error("docs down");
      applyDoc(doc, p.requests);
      return p.value;
    },
    async save(patch) {
      if (++saves === fail.save) throw new Error("db down");
      if (patch.doc_lines) store.lines = patch.doc_lines;
      if (patch.carried) store.carried = patch.carried;
    },
  };
}
const run = (doc: ReturnType<typeof docOf>, store: { lines: DocLine[]; carried: NoteItemRow[] }, items: DraftItem[], fail?: { step?: number; save?: number }) =>
  runReprepare(deps(doc, store, fail), { key: KEY, docId: "doc", tabId: TAB, profile: VECKOMOTE, ownerLabel, ...store, items, desired });

describe("runReprepare: a failure between steps never strands the agenda", () => {
  it("rewrite, the carried step fails: the next run writes the tasks once, nothing taken for a human deletion", async () => {
    const { doc, store } = prepared();
    const next = [draft[0], FEST, draft[2], draft[3]];
    // Steps: 1 reconcile, 2 rewrite, 3 carried.
    await expect(run(doc, store, next, { step: 3 })).rejects.toThrow("docs down");
    expect(store.carried.some((r) => r.deleted_by_human)).toBe(false);
    const res = await run(doc, store, next);
    expect(agenda(doc)).toEqual(["Agenda", "Godkänn dagordning", "Fest på universitetet", "Från förra veckan", "– Erik: Skicka kallelsen.", "– Kassör: Boka Kårallen.", "Övrigt"]);
    expect(res.carried.filter((r) => r.range_name)).toHaveLength(2);
  });

  it("merge, an insert is written but its save fails: the next run adopts the line instead of inserting it again", async () => {
    const { doc, store } = prepared();
    // A human edit forces merge.
    const mr = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: " (kort)", location: { tabId: TAB, index: mr.end - 1 } } }]);
    const next = [draft[0], draft[1], FEST, draft[2], draft[3]];
    // Saves: 1 after step 1, 2 after the insert.
    await expect(run(doc, store, next, { save: 2 })).rejects.toThrow("db down");
    const res = await run(doc, store, next);
    expect(res.mode).toBe("merge");
    expect(agenda(doc).filter((l) => l === "Fest på universitetet")).toHaveLength(1);
    expect(agenda(doc)).toContain("– Kassör: Boka Kårallen.");
  });

  it("a carried line written but not saved is removed and written once", async () => {
    const { doc, store } = prepared();
    const lost = { ...store, carried: [] as NoteItemRow[] };
    await run(doc, lost, draft);
    expect(agenda(doc).filter((l) => l.includes("Boka Kårallen"))).toHaveLength(1);
  });
});

describe("planReprepare: a region holding more than our lines is merged, never rewritten", () => {
  it("an image or page break (an object) or a table in the agenda", () => {
    const { doc, store } = prepared();
    const tab0 = parseNotesTab(doc, TAB);
    const p = tab0.paragraphs.find((x) => x.text === "Övrigt\n")!;
    // A paragraph holding only an inline object (an image, a page break), as parseNotesTab reads it.
    const img = prepared();
    const ov = parseNotesTab(img.doc, TAB).paragraphs.find((x) => x.text === "Övrigt\n")!;
    applyDoc(img.doc, [{ insertText: { text: "￼\n", location: { tabId: TAB, index: ov.start } } }]);
    expect(planReprepare(parseNotesTab(img.doc, TAB), VECKOMOTE, KEY, img.store.lines, img.store.carried, draft).mode).toBe("merge");
    const withTable: NotesTab = { ...tab0, tables: [...(tab0.tables ?? []), { start: p.start, end: p.end, rows: [] }] };
    expect(planReprepare(withTable, VECKOMOTE, KEY, store.lines, store.carried, draft).mode).toBe("merge");
    // A gap (a section break or table of contents: no paragraph there).
    const gap: NotesTab = { ...tab0, paragraphs: tab0.paragraphs.filter((x) => x !== p) };
    expect(planReprepare(gap, VECKOMOTE, KEY, store.lines, store.carried, draft).mode).toBe("merge");
    expect(planReprepare(tab0, VECKOMOTE, KEY, store.lines, store.carried, draft).mode).toBe("rewrite");
  });

  it("rewrite: the new lines are normal list items, not the tasks heading's style", () => {
    const { doc, store } = prepared();
    const plan = planReprepare(parseNotesTab(doc, TAB), VECKOMOTE, KEY, store.lines, store.carried, [draft[0], FEST, draft[2], draft[3]]);
    applyDoc(doc, plan.requests);
    const fest = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Fest på universitetet\n")!;
    expect(fest.style).toBe("NORMAL_TEXT");
    expect(fest.bullet?.level).toBe(0);
  });

  it("an insert after Från förra veckan goes below its carried lines", () => {
    const { doc, store } = prepared();
    // Övrigt deleted by a human: the new item has no next item to go before.
    const ov = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Övrigt\n")!;
    applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: ov.start, endIndex: ov.end } } }]);
    const items = [draft[0], draft[1], draft[2], FEST, draft[3]];
    const plan = planReprepare(parseNotesTab(doc, TAB), VECKOMOTE, KEY, store.lines, store.carried, items);
    applyDoc(doc, plan.requests);
    const ins = planInsert(parseNotesTab(doc, TAB), VECKOMOTE, KEY, plan.lines, items, "add:fest")!;
    applyDoc(doc, ins.requests);
    expect(agenda(doc).slice(-3)).toEqual(["– Erik: Skicka kallelsen.", "– Kassör: Boka Kårallen.", "Fest på universitetet"]);
  });
});
