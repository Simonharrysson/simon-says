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
import { followupKey, planCarried, planInsert, planItemRanges, planReprepare, prepKey, prepMeeting, type DocLine, type Journal } from "./doc";
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

type Store = { lines: DocLine[]; carried: NoteItemRow[]; journal: Journal | null; gen: number };

/** Deps on a docsim Doc: the n-th batch may fail before it is sent, or the n-th save fail (after the batch before it went through). */
function deps(doc: ReturnType<typeof docOf>, store: Store, fail: { step?: number; save?: number } = {}): ReprepareDeps {
  let steps = 0;
  let saves = 0;
  return {
    async step(plan, before) {
      const p = plan(parseNotesTab(doc, TAB));
      if (p.requests.length) {
        await before(p.journal);
        if (++steps === fail.step) throw new Error("docs down");
        applyDoc(doc, p.requests);
      }
      return p.value;
    },
    async save(patch) {
      if (++saves === fail.save) throw new Error("db down");
      if (patch.doc_lines) store.lines = patch.doc_lines;
      if (patch.carried) store.carried = patch.carried;
      if (patch.journal !== undefined) store.journal = patch.journal;
      if (patch.gen !== undefined) store.gen = patch.gen;
    },
  };
}
const run = (doc: ReturnType<typeof docOf>, store: Store, items: DraftItem[], fail?: { step?: number; save?: number }) =>
  runReprepare(deps(doc, store, fail), { key: KEY, docId: "doc", tabId: TAB, profile: VECKOMOTE, ownerLabel, ...store, items, desired });
const fresh = () => {
  const p = prepared();
  return { doc: p.doc, store: { ...p.store, journal: null, gen: 0 } as Store };
};
const EXPECTED = ["Agenda", "Godkänn dagordning", "Fest på universitetet", "Från förra veckan", "– Erik: Skicka kallelsen.", "– Kassör: Boka Kårallen.", "Övrigt"];

describe("runReprepare: a failure between a Doc batch and its save never strands the agenda", () => {
  const next = () => [draft[0], FEST, draft[2], draft[3]];

  it("the rewrite is written but its save fails: the next run settles it (no frozen lines, nothing taken for deleted, no duplicates)", async () => {
    const { doc, store } = fresh();
    // Saves: 1 gen, 2 after reconcile, 3 the rewrite's journal, 4 after the rewrite.
    await expect(run(doc, store, next(), { save: 4 })).rejects.toThrow("db down");
    expect(store.journal?.writes.length).toBeGreaterThan(0);
    const res = await run(doc, store, next());
    expect(agenda(doc)).toEqual(EXPECTED);
    expect(res.carried.filter((r) => r.deleted_by_human || r.locked)).toEqual([]);
    expect(store.journal).toBeNull();
    // Nothing reads as a human's edit: a third run rewrites again and changes nothing.
    const again = await run(doc, store, next());
    expect(again.mode).toBe("rewrite");
    expect(agenda(doc)).toEqual(EXPECTED);
  });

  it("the carried lines are written but not saved: settled, written once", async () => {
    const { doc, store } = fresh();
    // Saves: 1 gen, 2 reconcile, 3 rewrite journal, 4 rewrite, 5 carried journal, 6 carried.
    await expect(run(doc, store, next(), { save: 6 })).rejects.toThrow("db down");
    await run(doc, store, next());
    expect(agenda(doc)).toEqual(EXPECTED);
  });

  it("a batch that failed before it was sent: the next run simply does it", async () => {
    const { doc, store } = fresh();
    await expect(run(doc, store, next(), { step: 1 })).rejects.toThrow("docs down");
    await run(doc, store, next());
    expect(agenda(doc)).toEqual(EXPECTED);
  });

  it("a human edit inside an unsaved line of ours is kept, never deleted", async () => {
    const { doc, store } = fresh();
    await expect(run(doc, store, next(), { save: 6 })).rejects.toThrow("db down");
    const kar = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text.startsWith("– Kassör"))!;
    applyDoc(doc, [{ insertText: { text: " Bokat!", location: { tabId: TAB, index: kar.end - 2 } } }]);
    await run(doc, store, next());
    expect(agenda(doc)).toContain("– Erik: Skicka kallelsen.");
    expect(agenda(doc).filter((l) => l.includes("Boka Kårallen"))).toEqual(["– Kassör: Boka Kårallen Bokat!."]);
  });

  it("the settling batch lands but its save fails: the journal survives, still no duplicate", async () => {
    const { doc, store } = fresh();
    const mr = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: " (kort)", location: { tabId: TAB, index: mr.end - 1 } } }]);
    const items = [draft[0], draft[1], FEST, draft[2], draft[3]];
    await expect(run(doc, store, items, { save: 5 })).rejects.toThrow("db down");
    // A stray range of ours, so settling has a batch of its own; the save after it fails.
    const ov = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Övrigt\n")!;
    applyDoc(doc, [{ createNamedRange: { name: `ss-${KEY}-zz`, range: { tabId: TAB, startIndex: ov.start, endIndex: ov.start + 3 } } }]);
    await expect(run(doc, store, items, { save: 2 })).rejects.toThrow("db down");
    expect(store.journal?.writes.length).toBeGreaterThan(0);
    await run(doc, store, items);
    expect(agenda(doc).filter((l) => l === "Fest på universitetet")).toHaveLength(1);
    expect(agenda(doc).filter((l) => l.includes("Boka Kårallen"))).toHaveLength(1);
  });

  it("a new item line a human edited before the save stays tracked (theirs), never inserted again", async () => {
    const { doc, store } = fresh();
    const mr = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: " (kort)", location: { tabId: TAB, index: mr.end - 1 } } }]);
    const items = [draft[0], draft[1], FEST, draft[2], draft[3]];
    await expect(run(doc, store, items, { save: 5 })).rejects.toThrow("db down");
    const fest = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Fest på universitetet\n")!;
    applyDoc(doc, [{ insertText: { text: " stora", location: { tabId: TAB, index: fest.start + 4 } } }]);
    await run(doc, store, items);
    expect(agenda(doc).filter((l) => l.includes("universitetet"))).toEqual(["Fest stora på universitetet"]);
  });

  it("merge: an inserted line whose save failed is adopted, never inserted twice", async () => {
    const { doc, store } = fresh();
    const mr = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: " (kort)", location: { tabId: TAB, index: mr.end - 1 } } }]);
    const items = [draft[0], draft[1], FEST, draft[2], draft[3]];
    // Saves: 1 gen, 2 reconcile, 3 after merge (no batch: nothing to delete or replace), 4 insert journal, 5 after the insert.
    await expect(run(doc, store, items, { save: 5 })).rejects.toThrow("db down");
    const res = await run(doc, store, items);
    expect(res.mode).toBe("merge");
    expect(agenda(doc).filter((l) => l === "Fest på universitetet")).toHaveLength(1);
    expect(agenda(doc)).toContain("– Kassör: Boka Kårallen.");
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
