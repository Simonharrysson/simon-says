import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import { VECKOMOTE } from "@/lib/formats/standard";
import type { NotesItem } from "@/lib/notes/schema";
import fixture from "@/fixtures/agenda/veckomote.doc.json";

const api = vi.hoisted(() => ({ get: vi.fn(), batchUpdate: vi.fn() }));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: api.get, batchUpdate: api.batchUpdate } }),
}));

import { readState } from "@/lib/meetings/tick";
import { expandCopies, formatLine, planFormatRender, type LineCtx } from "./format-render";
import { currentItems, dedupeById, diffHumanEdits, ownedSpan, parseNotesTab, renderedRows, renderItems, toNotesItem } from "./notes";

// Fictional agenda Doc from Task A1 (fixtures/agenda/veckomote.doc.json):
//   [91,110) Godkänn dagordning · [110,119) Må-runda · [119,137) Från förra veckan ·
//   [137,152) Kommande event with sub-bullets [152,175) Sommarfest på Kårallen, [175,197) Workshop om sponsring ·
//   [197,205) Ekonomi · [205,212) Övrigt · [212,245) H2 tasks heading · [245,269) "Ordförande: Boka lokal." ·
//   [269,283) H1 "Anteckningar:"; info table cells Datum/Tid/Närvarande empty, Sekreterare "Elin Berglund".

type Doc = docs_v1.Schema$Document;
type El = docs_v1.Schema$StructuralElement;

const TAB = "t.0";
const LIST = "kix.c40iceluu4t4";
const LIVE = "Simon Says antecknar live · uppdaterad 18:05";
const ITEMS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"];
const auth = {} as OAuth2Client;

const PEOPLE: Record<string, string> = { "Anna Berg": "Kassör", "Erik Lund": "Ordförande", "Lisa Holm": "Kassör" };
const ctx: LineCtx = { profile: VECKOMOTE, ownerLabel: (o) => PEOPLE[o] ?? o };

const clone = (d: unknown): Doc => JSON.parse(JSON.stringify(d)) as Doc;
const body = (doc: Doc): El[] => doc.tabs![0].documentTab!.body!.content!;
const textOf = (el: El) => (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");

function para(text: string, opts: { level?: number; listId?: string; style?: string } = {}): El {
  return {
    startIndex: 0,
    endIndex: 0,
    paragraph: {
      elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }],
      paragraphStyle: { namedStyleType: opts.style ?? "NORMAL_TEXT" },
      ...(opts.level !== undefined ? { bullet: { listId: opts.listId ?? LIST, nestingLevel: opts.level } } : {}),
    },
  };
}

/** Recompute every index from the content (paragraph = its text; table +1, row +1, cell +1, end +1). */
function reindex(doc: Doc) {
  let at = 1;
  const visit = (content: El[]) => {
    for (const el of content) {
      if (el.sectionBreak) continue;
      el.startIndex = at;
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          pe.startIndex = at;
          at += pe.textRun?.content?.length ?? 1;
          pe.endIndex = at;
        }
      } else if (el.table) {
        at += 1;
        for (const row of el.table.tableRows ?? []) {
          row.startIndex = at;
          at += 1;
          for (const cell of row.tableCells ?? []) {
            cell.startIndex = at;
            at += 1;
            visit(cell.content ?? []);
            cell.endIndex = at;
          }
          row.endIndex = at;
        }
        at += 1;
      }
      el.endIndex = at;
    }
  };
  visit(body(doc));
}

const elByText = (doc: Doc, text: string) => {
  const el = body(doc).find((e) => textOf(e) === `${text}\n`);
  if (!el) throw new Error(`no paragraph "${text}"`);
  return el;
};
function insertAfter(doc: Doc, after: string, text: string, opts: Parameters<typeof para>[1] = {}) {
  const b = body(doc);
  b.splice(b.indexOf(elByText(doc, after)) + 1, 0, para(text, opts));
  reindex(doc);
}
function removePara(doc: Doc, text: string) {
  const b = body(doc);
  b.splice(b.indexOf(elByText(doc, text)), 1);
  reindex(doc);
}
function setLevel(doc: Doc, text: string, level: number) {
  elByText(doc, text).paragraph!.bullet!.nestingLevel = level;
}
/** The value cell (column 1) of info-table row `row`. */
const valueCell = (doc: Doc, row: number) => body(doc).find((e) => e.table)!.table!.tableRows![row].tableCells![1];
function setCell(doc: Doc, row: number, text: string) {
  const cell = valueCell(doc, row);
  cell.content = [para(text)];
  reindex(doc);
}

/** Named ranges by paragraph text (whole text, newline excluded); `cell:<row>` = that value cell's text. */
function withRanges(doc: Doc, ranges: [string, string][]) {
  const named: Record<string, docs_v1.Schema$NamedRanges> = {};
  for (const [name, where] of ranges) {
    let start: number;
    let end: number;
    if (where.startsWith("cell:")) {
      const p = valueCell(doc, Number(where.slice(5))).content![0];
      start = p.startIndex!;
      end = p.endIndex! - 1;
    } else {
      const el = elByText(doc, where);
      start = el.startIndex!;
      end = el.endIndex! - 1;
    }
    named[name] = { name, namedRanges: [{ namedRangeId: `id-${name}`, name, ranges: [{ startIndex: start, endIndex: end }] }] };
  }
  doc.tabs![0].documentTab!.namedRanges = named;
  return doc;
}

const ANCHORS: [string, string][] = [
  ...ITEMS.map((t, i): [string, string] => [`ss-m1-ag-${i + 1}`, t]),
  ["ss-m1-sec-tasks", "Vad ska vi göra till nästa gång?"],
  ["ss-m1-sec-notes", "Anteckningar:"],
  ["ss-m1-live", LIVE],
];

/** The fixture after anchoring (A7): the LIVE line after "Anteckningar:", anchors on items and headings. */
function anchored(edit?: (doc: Doc) => void, extra: [string, string][] = [], drop: string[] = []): Doc {
  const doc = clone(fixture);
  insertAfter(doc, "Anteckningar:", LIVE);
  edit?.(doc);
  return withRanges(doc, [...ANCHORS.filter(([n]) => !drop.includes(n)), ...extra]);
}

const meeting: MeetingRow = {
  id: "m1",
  org_id: "o1",
  started_by: null,
  doc_id: "d1",
  notes_tab_id: TAB,
  transcript_tab_id: null,
  header_range: "ss-m1-live",
  header_rendered: LIVE,
  section_ranges: {
    ...Object.fromEntries(ITEMS.map((_, i) => [`ag-${i + 1}`, `ss-m1-ag-${i + 1}`])),
    tasks: "ss-m1-sec-tasks",
    notes: "ss-m1-sec-notes",
    live: "ss-m1-live",
  },
  status: "live",
  consent_confirmed_at: null,
  started_at: "2026-11-25T17:05:00Z",
  ended_at: null,
  last_heartbeat_at: null,
  last_tick_at: null,
  last_tick_ok_at: null,
  failed_ticks: 0,
  tick_lease_until: null,
  doc_paused_at: null,
  current_el_session_id: null,
  layout: "format",
  agenda_doc: true,
};

function row(item: NotesItem, last: string | null, extra: Partial<NoteItemRow> = {}): NoteItemRow {
  return {
    meeting_id: "m1",
    id: item.id,
    section: item.section,
    text: item.text,
    owner: item.owner ?? null,
    due: item.due ?? null,
    locked: false,
    deleted_by_human: false,
    last_rendered_text: last,
    range_name: last === null ? null : `ss-m1-${item.id}`,
    position: 0,
    anchor: item.anchor ?? null,
    copy_of: item.copyOf ?? null,
    ...extra,
  };
}

const plan = (doc: Doc, rows: NoteItemRow[], desired: NotesItem[], more: { headerText?: string; newAnchors?: { key: string; start: number; end: number }[] } = {}) =>
  planFormatRender(meeting, parseNotesTab(doc, TAB), rows, desired, { profile: VECKOMOTE, ownerLabel: ctx.ownerLabel, ...more });

const inserts = (p: { requests: docs_v1.Schema$Request[] }) =>
  p.requests.filter((r) => r.insertText).map((r) => [r.insertText!.location!.index, r.insertText!.text]);
const named = (p: { requests: docs_v1.Schema$Request[] }) =>
  Object.fromEntries(p.requests.filter((r) => r.createNamedRange).map((r) => [r.createNamedRange!.name, [r.createNamedRange!.range!.startIndex, r.createNamedRange!.range!.endIndex]]));

/** The style reset sent over every line of ours (inserted text inherits the previous character's style). */
const plainText = (startIndex: number, endIndex: number) => ({
  updateTextStyle: {
    range: { tabId: TAB, startIndex, endIndex },
    textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
    fields: "bold,italic,underline,strikethrough,link",
  },
});

const note = (id: string, anchor: string, text: string): NotesItem => ({ id, section: "note", text, anchor });
const task = (id: string, anchor: string, text: string, owner?: string, due?: string): NotesItem => ({
  id, section: "action", text, anchor, ...(owner ? { owner } : {}), ...(due ? { due } : {}),
});

describe("formatLine", () => {
  it("formats tasks role-first, decisions with the prefix, notes as sentences", () => {
    const t: NotesItem = { id: "n1", section: "action", text: "Mejla klubben om avgiften.", owner: "Anna Berg", due: "fre" };
    expect(formatLine(t, ctx)).toBe("Kassör: Mejla klubben om avgiften (fre).");
    expect(formatLine({ ...t, done: true }, ctx)).toBe("Kassör: Mejla klubben om avgiften (fre). ✓ klart");
    expect(formatLine({ ...t, owner: undefined, due: undefined }, ctx)).toBe("Mejla klubben om avgiften.");
    expect(formatLine({ id: "n2", section: "decision", text: "vi köper flaggor" }, ctx)).toBe("Beslut: vi köper flaggor.");
    expect(formatLine({ id: "n3", section: "note", text: "Alla  var\nnöjda!" }, ctx)).toBe("Alla var nöjda!");
    expect(formatLine({ id: "n4", section: "note", text: "Budgeten håller" }, ctx)).toBe("Budgeten håller.");
  });

  it("writes info cells and attendees as is (F1: no final period)", () => {
    expect(formatLine({ id: "info-tid", section: "note", text: "18:05–19:10", anchor: "info.tid" }, ctx)).toBe("18:05–19:10");
    expect(formatLine({ id: "info-narvarande", section: "attendees", text: "Anna Berg, Erik Lund", anchor: "info.narvarande" }, ctx)).toBe("Anna Berg, Erik Lund");
  });
});

describe("planFormatRender under agenda items", () => {
  it("(c) under an item without sub-bullets: '– ' prefix inside our range, ownedSpan holds (Ruling R-A1)", () => {
    const n1 = note("n1", "ag-5", "Budgeten är godkänd");
    const p = plan(anchored(), [], [n1]);
    // Ekonomi is [197,205): "\n<line>" before its newline, bullets off, indent, then the prefix.
    expect(p.requests).toEqual([
      { insertText: { text: "\nBudgeten är godkänd.", location: { tabId: TAB, index: 204 } } },
      { deleteParagraphBullets: { range: { tabId: TAB, startIndex: 205, endIndex: 225 } } },
      {
        updateParagraphStyle: {
          range: { tabId: TAB, startIndex: 205, endIndex: 225 },
          paragraphStyle: { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: 54, unit: "PT" }, indentFirstLine: { magnitude: 36, unit: "PT" } },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      },
      { insertText: { text: "– ", location: { tabId: TAB, index: 205 } } },
      { createNamedRange: { name: "ss-m1-n1", range: { tabId: TAB, startIndex: 205, endIndex: 227 } } },
      plainText(205, 227),
    ]);
    const rows = renderedRows("m1", [], [n1], p);
    expect(rows[0]).toMatchObject({ id: "n1", last_rendered_text: "– Budgeten är godkänd.", anchor: "ag-5", kind: "note", range_name: "ss-m1-n1" });

    // The Doc after that batch: our plain paragraph, range over the whole text incl. the prefix.
    const doc = anchored((d) => insertAfter(d, "Ekonomi", "– Budgeten är godkänd."), [["ss-m1-n1", "– Budgeten är godkänd."]]);
    const tab = parseNotesTab(doc, TAB);
    const span = ownedSpan(tab, rows[0]);
    expect(span).not.toBeNull();
    expect(span!.rangeText).toBe(span!.paraText);
    expect(plan(doc, rows, [n1]).requests).toEqual([]);
    // A reworded note keeps its prefix.
    expect(plan(doc, rows, [{ ...n1, text: "Budgeten är nu godkänd" }]).requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-n1", text: "– Budgeten är nu godkänd.", tabsCriteria: { tabIds: [TAB] } } },
    ]);
    // A second note goes after ours the same way (the item still has no list sub-bullet).
    const n2 = note("n2", "ag-5", "Kassan stämmer");
    const p2 = plan(doc, rows, [n1, n2]);
    expect(inserts(p2)).toEqual([[227, "\nKassan stämmer."], [228, "– "]]);
    expect(p2.requests.some((r) => r.deleteParagraphBullets)).toBe(false); // ours has no bullet
  });

  it("(b) after the item's last sub-bullet; then after ours; then after a human line typed after ours", () => {
    const n1 = note("n1", "ag-4", "Sommarfesten blir 14 juni");
    const p1 = plan(anchored(), [], [n1]);
    // Kommande event's block ends with "Workshop om sponsring" [175,197): blockEnd - 1 = 196.
    expect(p1.requests).toEqual([
      { insertText: { text: "\nSommarfesten blir 14 juni.", location: { tabId: TAB, index: 196 } } },
      { createNamedRange: { name: "ss-m1-n1", range: { tabId: TAB, startIndex: 197, endIndex: 223 } } },
      plainText(197, 223),
    ]);
    const rows1 = renderedRows("m1", [], [n1], p1);
    expect(rows1[0].last_rendered_text).toBe("Sommarfesten blir 14 juni.");

    // Next render: ours is in the Doc (inherited level 1), a second note goes after it.
    const ours = "Sommarfesten blir 14 juni.";
    const doc2 = anchored((d) => insertAfter(d, "Workshop om sponsring", ours, { level: 1 }), [["ss-m1-n1", ours]]);
    const n2 = note("n2", "ag-4", "Workshopen flyttas");
    const p2 = plan(doc2, rows1, [n1, n2]);
    expect(inserts(p2)).toEqual([[223, "\nWorkshopen flyttas."]]);
    expect(named(p2)).toEqual({ "ss-m1-n2": [224, 243] });
    const rows2 = renderedRows("m1", rows1, [n1, n2], p2);

    // A human typed a sub-bullet after ours: the third goes after the human's, never between.
    const doc3 = anchored(
      (d) => {
        insertAfter(d, "Workshop om sponsring", ours, { level: 1 });
        insertAfter(d, ours, "Workshopen flyttas.", { level: 1 });
        insertAfter(d, "Workshopen flyttas.", "Fråga Bo om lokalen", { level: 1 });
      },
      [["ss-m1-n1", ours], ["ss-m1-n2", "Workshopen flyttas."]],
    );
    const n3 = note("n3", "ag-4", "Affischer behövs");
    const p3 = plan(doc3, rows2, [n1, n2, n3]);
    const human = parseNotesTab(doc3, TAB).paragraphs.find((x) => x.text === "Fråga Bo om lokalen\n")!;
    expect(inserts(p3)).toEqual([[human.end - 1, "\nAffischer behövs."]]);
    expect(p3.requests).toHaveLength(3);
  });

  it("a human Tab on one of ours changes only its level: not locked, nothing rewritten, no level request", () => {
    const n1 = note("n1", "ag-4", "Sommarfesten blir 14 juni");
    const ours = "Sommarfesten blir 14 juni.";
    const rows = [row(n1, ours)];
    const doc = anchored((d) => {
      insertAfter(d, "Workshop om sponsring", ours, { level: 1 });
      setLevel(d, ours, 2);
    }, [["ss-m1-n1", ours]]);
    const tab = parseNotesTab(doc, TAB);
    const diff = diffHumanEdits(rows, currentItems(tab, rows));
    expect(diff.rows[0].locked).toBe(false);
    expect(ownedSpan(tab, rows[0])).not.toBeNull();
    expect(plan(doc, rows, [n1]).requests).toEqual([]);
  });

  it("block ending in a human level-2 point → our line is (c), never a level-2 child of their point", () => {
    const doc = anchored((d) => insertAfter(d, "Workshop om sponsring", "Fråga om pris", { level: 2 }));
    const tab = parseNotesTab(doc, TAB);
    const deep = tab.paragraphs.find((x) => x.text === "Fråga om pris\n")!;
    const p = plan(doc, [], [note("n1", "ag-4", "Workshopen flyttas")]);
    expect(inserts(p)).toEqual([[deep.end - 1, "\nWorkshopen flyttas."], [deep.end, "– "]]);
    expect(p.requests.some((r) => r.deleteParagraphBullets)).toBe(true);
    expect(renderedRows("m1", [], [note("n1", "ag-4", "Workshopen flyttas")], p)[0].last_rendered_text).toBe("– Workshopen flyttas.");
  });

  it("a heading item gets NORMAL_TEXT and a new bullet list", () => {
    const doc = anchored((d) => {
      const el = elByText(d, "Ekonomi");
      delete el.paragraph!.bullet;
      el.paragraph!.paragraphStyle = { namedStyleType: "HEADING_3" };
    });
    const p = plan(doc, [], [note("n1", "ag-5", "Budgeten är godkänd")]);
    expect(p.requests).toEqual([
      { insertText: { text: "\nBudgeten är godkänd.", location: { tabId: TAB, index: 204 } } },
      { updateParagraphStyle: { range: { tabId: TAB, startIndex: 205, endIndex: 225 }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
      { createParagraphBullets: { range: { tabId: TAB, startIndex: 205, endIndex: 225 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
      { createNamedRange: { name: "ss-m1-n1", range: { tabId: TAB, startIndex: 205, endIndex: 225 } } },
      plainText(205, 225),
    ]);
  });

  it("never anchors an insert on a paragraph deleted in the same batch", () => {
    const n1 = note("n1", "ag-4", "Gammal rad");
    const doc = anchored((d) => insertAfter(d, "Workshop om sponsring", "Gammal rad.", { level: 1 }), [["ss-m1-n1", "Gammal rad."]]);
    const p = plan(doc, [row(n1, "Gammal rad.")], [note("n2", "ag-4", "Ny rad")]);
    expect(p.removed).toEqual(new Set(["n1"]));
    // Delete [197,209) first, then insert after "Workshop om sponsring" (196), not inside the deleted paragraph.
    expect(p.requests[0]).toEqual({ deleteNamedRange: { name: "ss-m1-n1", tabsCriteria: { tabIds: [TAB] } } });
    expect(p.requests[1]).toEqual({ deleteContentRange: { range: { tabId: TAB, startIndex: 197, endIndex: 209 } } });
    expect(inserts(p)).toEqual([[196, "\nNy rad."]]);
  });

  it("anchor range gone (ag-6 deleted) → no insert; its existing items keep their rows", () => {
    const old = note("n1", "ag-6", "Tidigare rad");
    const doc = anchored((d) => insertAfter(d, "Övrigt", "– Tidigare rad."), [["ss-m1-n1", "– Tidigare rad."]], ["ss-m1-ag-6"]);
    const rows = [row(old, "– Tidigare rad.")];
    const p = plan(doc, rows, [old, note("n2", "ag-6", "Ny punkt"), note("n3", "ag-9", "Okänt ankare")]);
    expect(p.requests).toEqual([]);
    expect(p.applied).toEqual(new Set(["n1"]));
    expect(renderedRows("m1", rows, [old], p)).toEqual([{ ...rows[0], kind: "note", done: false }]);
  });

  it("newAnchors → createNamedRange ss-m1-<key>, and items under them are placed in the same batch", () => {
    const doc = anchored();
    const p = plan(doc, [], [note("n1", "ag-7", "Ny punkt")], { newAnchors: [{ key: "ag-7", start: 205, end: 211 }] });
    expect(named(p)).toEqual({ "ss-m1-ag-7": [205, 211], "ss-m1-n1": [212, 223] });
    expect(inserts(p)).toEqual([[211, "\nNy punkt."], [212, "– "]]);
  });
});

describe("planFormatRender on a bold-only agenda (no lists, no HEADING_* items)", () => {
  const boldPara = (text: string) => {
    const el = para(text);
    el.paragraph!.elements![0].textRun!.textStyle = { bold: true };
    return el;
  };
  /** "Agenda:", bold items Ekonomi and Sommarfest, the tasks and notes headings, the LIVE line. */
  function boldDoc(edit?: (doc: Doc) => void, extra: [string, string][] = []): Doc {
    const doc = clone(fixture);
    doc.tabs![0].documentTab!.body!.content = [
      { endIndex: 1, sectionBreak: {} },
      para("Agenda:"),
      boldPara("Ekonomi"),
      boldPara("Sommarfest"),
      para("Vad ska vi göra till nästa gång?", { style: "HEADING_2" }),
      para("Anteckningar:", { style: "HEADING_1" }),
      para(LIVE),
    ];
    doc.tabs![0].documentTab!.lists = {};
    reindex(doc);
    edit?.(doc);
    return withRanges(doc, [
      ["ss-m1-ag-1", "Ekonomi"],
      ["ss-m1-ag-2", "Sommarfest"],
      ["ss-m1-sec-tasks", "Vad ska vi göra till nästa gång?"],
      ["ss-m1-sec-notes", "Anteckningar:"],
      ["ss-m1-live", LIVE],
      ...extra,
    ]);
  }

  it("our bullet list under a bold item does not unmake the items on the next render", () => {
    const n1 = note("n1", "ag-1", "Budgeten håller");
    const p1 = plan(boldDoc(), [], [n1]);
    // Ekonomi is [9,17): a new bulleted NORMAL_TEXT paragraph, inherited bold cleared.
    expect(p1.requests).toEqual([
      { insertText: { text: "\nBudgeten håller.", location: { tabId: TAB, index: 16 } } },
      { updateParagraphStyle: { range: { tabId: TAB, startIndex: 17, endIndex: 33 }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
      { createParagraphBullets: { range: { tabId: TAB, startIndex: 17, endIndex: 33 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
      { createNamedRange: { name: "ss-m1-n1", range: { tabId: TAB, startIndex: 17, endIndex: 33 } } },
      plainText(17, 33),
    ]);
    const rows = renderedRows("m1", [], [n1], p1);
    // Next render: ours is a bullet in a new list. Both items are still found.
    const doc = boldDoc((d) => insertAfter(d, "Ekonomi", "Budgeten håller.", { level: 0, listId: "kix.ours" }), [["ss-m1-n1", "Budgeten håller."]]);
    const p2 = plan(doc, rows, [n1, note("n2", "ag-1", "Kassan stämmer"), note("n3", "ag-2", "Festen blir i juni")]);
    const ours = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Budgeten håller.\n")!;
    const fest = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Sommarfest\n")!;
    expect(inserts(p2)).toEqual([[fest.end - 1, "\nFesten blir i juni."], [ours.end - 1, "\nKassan stämmer."]]);
    // n2 joins our list (b): no new list request for it.
    expect(p2.requests.filter((r) => r.createParagraphBullets)).toHaveLength(1);
  });
});

describe("planFormatRender tasks and their copies", () => {
  const anna = task("n1", "ag-5", "Mejla klubben om avgiften.", "Anna Berg", "fre");
  const erik = task("n2", "ag-5", "Boka bussen", "Erik Lund");
  // A human line after "Ordförande: Boka lokal." so "after the same label" and "end of block" differ.
  const tasksDoc = (more?: (d: Doc) => void) =>
    anchored((d) => {
      insertAfter(d, "Ordförande: Boka lokal.", "Sekreterare: Skicka protokollet.");
      more?.(d);
    });

  it("without a notes section the tasks block ends at the LIVE line", () => {
    // Like a Styrelseprotokoll Doc: no notes heading, the LIVE line appended after the tasks.
    const doc = anchored((d) => removePara(d, "Anteckningar:"), [], ["ss-m1-sec-notes"]);
    const m = { ...meeting, section_ranges: { ...meeting.section_ranges, notes: undefined } };
    const tab = parseNotesTab(doc, TAB);
    const p = planFormatRender(m, tab, [], [task("n1-t", "tasks", "Ring banken", "Lisa Holm")], { profile: { ...VECKOMOTE, notesSection: null }, ownerLabel: ctx.ownerLabel });
    const last = tab.paragraphs.find((x) => x.text === "Ordförande: Boka lokal.\n")!;
    expect(inserts(p)).toEqual([[last.end - 1, "\nKassör: Ring banken."]]);
  });

  it("expandCopies adds one -t copy per unlocked, uncarried task primary", () => {
    const carried: NotesItem = { ...task("c1", "ag-3", "Kolla tröjorna", "Anna Berg"), carried: true };
    const out = expandCopies([anna, note("n3", "ag-4", "x"), carried], [], VECKOMOTE);
    expect(out.map((i) => i.id)).toEqual(["n1", "n3", "c1", "n1-t"]);
    expect(out[3]).toEqual({ ...anna, id: "n1-t", anchor: "tasks", copyOf: "n1" });
    expect(expandCopies([anna], [], { ...VECKOMOTE, tasksSection: null })).toEqual([anna]);
  });

  it("a task yields two inserts: under ag-5 and its copy next to the same label, else at the end of the tasks block", () => {
    const doc = tasksDoc();
    const tab = parseNotesTab(doc, TAB);
    const at = (t: string) => tab.paragraphs.find((x) => x.text === `${t}\n`)!.end - 1;
    const p = plan(doc, [], expandCopies([anna, erik], [], VECKOMOTE));
    expect(inserts(p)).toEqual([
      [at("Sekreterare: Skicka protokollet."), "\nKassör: Mejla klubben om avgiften (fre)."],
      [at("Ordförande: Boka lokal."), "\nOrdförande: Boka bussen."],
      [204, "\nKassör: Mejla klubben om avgiften (fre).\nOrdförande: Boka bussen."],
      [246, "– "],
      [205, "– "],
    ]);
    expect(Object.keys(named(p)).sort()).toEqual(["ss-m1-n1", "ss-m1-n1-t", "ss-m1-n2", "ss-m1-n2-t"]);
    const rows = renderedRows("m1", [], expandCopies([anna, erik], [], VECKOMOTE), p);
    expect(rows.find((r) => r.id === "n1-t")).toMatchObject({ anchor: "tasks", copy_of: "n1", kind: "task", last_rendered_text: "Kassör: Mejla klubben om avgiften (fre)." });
    expect(rows.find((r) => r.id === "n1")).toMatchObject({ last_rendered_text: "– Kassör: Mejla klubben om avgiften (fre).", copy_of: null });
  });

  it("a second Kassör task's copy lands right after the first Kassör copy", () => {
    const copy = "Kassör: Mejla klubben om avgiften (fre).";
    const doc = withRanges(
      tasksDoc((d) => {
        insertAfter(d, "Ekonomi", `– ${copy}`);
        insertAfter(d, "Ordförande: Boka lokal.", copy);
      }),
      [...ANCHORS, ["ss-m1-n1", `– ${copy}`], ["ss-m1-n1-t", copy]],
    );
    const rows = [row(anna, `– ${copy}`), row({ ...anna, id: "n1-t", anchor: "tasks", copyOf: "n1" }, copy)];
    const lisa = task("n3", "ag-4", "Betala hyran", "Lisa Holm");
    const p = plan(doc, rows, expandCopies([anna, lisa], rows, VECKOMOTE));
    const tab = parseNotesTab(doc, TAB);
    const ourCopy = tab.paragraphs.find((x) => x.text === `${copy}\n`)!;
    expect(inserts(p)).toContainEqual([ourCopy.end - 1, "\nKassör: Betala hyran."]);
  });

  it("copy edited by a human → copy locked, the primary still updated next render", () => {
    const copy = "Kassör: Mejla klubben om avgiften (fre).";
    const doc = withRanges(
      tasksDoc((d) => {
        insertAfter(d, "Ekonomi", `– ${copy}`);
        insertAfter(d, "Ordförande: Boka lokal.", `${copy} Klart!`);
      }),
      [...ANCHORS, ["ss-m1-n1", `– ${copy}`], ["ss-m1-n1-t", `${copy} Klart!`]],
    );
    const rows = [row(anna, `– ${copy}`), row({ ...anna, id: "n1-t", anchor: "tasks", copyOf: "n1" }, copy)];
    const state = readState(parseNotesTab(doc, TAB), rows);
    expect(state.diff.rows.find((r) => r.id === "n1-t")).toMatchObject({ locked: true, text: `${copy} Klart!` });
    expect(state.diff.rows.find((r) => r.id === "n1")!.locked).toBe(false);
    const changed = { ...anna, due: "mån" };
    const p = plan(doc, state.diff.rows, expandCopies([changed, ...state.diff.locked], state.diff.rows, VECKOMOTE));
    expect(p.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-n1", text: "– Kassör: Mejla klubben om avgiften (mån).", tabsCriteria: { tabIds: [TAB] } } },
    ]);
  });

  it("primary locked (R-A6) → the tasks copy keeps updating, incl. ✓ klart; also when the primary is deleted", () => {
    const copy = "Kassör: Mejla klubben om avgiften (fre).";
    const doc = withRanges(
      tasksDoc((d) => {
        insertAfter(d, "Ekonomi", "– Anna mejlar klubben.");
        insertAfter(d, "Ordförande: Boka lokal.", copy);
      }),
      [...ANCHORS, ["ss-m1-n1", "– Anna mejlar klubben."], ["ss-m1-n1-t", copy]],
    );
    const rows = [row(anna, `– ${copy}`), row({ ...anna, id: "n1-t", anchor: "tasks", copyOf: "n1" }, copy)];
    const state = readState(parseNotesTab(doc, TAB), rows);
    expect(state.diff.rows.find((r) => r.id === "n1")!.locked).toBe(true);
    const replaceCopy = (text: string) => ({
      replaceNamedRangeContent: { namedRangeName: "ss-m1-n1-t", text, tabsCriteria: { tabIds: [TAB] } },
    });
    // Nothing new: the copy is rendered from its row, unchanged → no request, nothing removed.
    const same = plan(doc, state.diff.rows, expandCopies(state.diff.locked, state.diff.rows, VECKOMOTE));
    expect(same.requests).toEqual([]);
    expect(same.removed.size).toBe(0);
    // The copy given by the caller (Claude's own item for it) is reworded in place.
    const copyItem = { ...toNotesItem(state.diff.rows.find((r) => r.id === "n1-t")!), due: "mån" };
    expect(plan(doc, state.diff.rows, expandCopies([...state.diff.locked, copyItem], state.diff.rows, VECKOMOTE)).requests).toEqual([
      replaceCopy("Kassör: Mejla klubben om avgiften (mån)."),
    ]);
    // Done reported on the (locked) primary reaches the copy.
    const doneRows = state.diff.rows.map((r) => (r.id === "n1" ? { ...r, done: true } : r));
    const doneDesired = expandCopies(state.diff.locked.map((i) => ({ ...i, done: true })), doneRows, VECKOMOTE);
    const p = plan(doc, doneRows, doneDesired);
    expect(p.requests).toEqual([replaceCopy(`${copy} ✓ klart`)]);
    expect(renderedRows("m1", doneRows, doneDesired, p).find((r) => r.id === "n1-t")).toMatchObject({ done: true, last_rendered_text: `${copy} ✓ klart` });
    // Primary deleted by a human: the copy stays and still updates.
    const deleted = state.diff.rows.map((r) => (r.id === "n1" ? { ...r, locked: false, deleted_by_human: true, done: true } : r));
    const p2 = plan(doc, deleted, expandCopies([], deleted, VECKOMOTE));
    expect(p2.requests).toEqual([replaceCopy(`${copy} ✓ klart`)]);
    expect(p2.removed.size).toBe(0);
  });

  it("copy locked (R-A6) → the primary keeps updating, incl. ✓ klart, the copy is never touched", () => {
    const copy = "Kassör: Mejla klubben om avgiften (fre).";
    const doc = withRanges(
      tasksDoc((d) => {
        insertAfter(d, "Ekonomi", `– ${copy}`);
        insertAfter(d, "Ordförande: Boka lokal.", "Anna har redan mejlat.");
      }),
      [...ANCHORS, ["ss-m1-n1", `– ${copy}`], ["ss-m1-n1-t", "Anna har redan mejlat."]],
    );
    const rows = [row(anna, `– ${copy}`), row({ ...anna, id: "n1-t", anchor: "tasks", copyOf: "n1" }, copy)];
    const state = readState(parseNotesTab(doc, TAB), rows);
    expect(state.diff.rows.find((r) => r.id === "n1-t")!.locked).toBe(true);
    const p = plan(doc, state.diff.rows, expandCopies([{ ...anna, done: true }, ...state.diff.locked], state.diff.rows, VECKOMOTE));
    expect(p.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-n1", text: `– ${copy} ✓ klart`, tabsCriteria: { tabIds: [TAB] } } },
    ]);
  });
});

describe("duplicate ids in desired", () => {
  it("last one wins: one replace, and the stored line equals what was written", () => {
    const n1 = note("n1", "ag-5", "Budgeten är godkänd");
    const doc = anchored((d) => insertAfter(d, "Ekonomi", "– Budgeten är godkänd."), [["ss-m1-n1", "– Budgeten är godkänd."]]);
    const rows = [row(n1, "– Budgeten är godkänd.")];
    const desired = [{ ...n1, text: "Första" }, { ...n1, text: "Andra" }];
    const p = plan(doc, rows, desired);
    expect(p.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-n1", text: "– Andra.", tabsCriteria: { tabIds: [TAB] } } },
    ]);
    expect(renderedRows("m1", rows, dedupeById(desired), p)[0].last_rendered_text).toBe("– Andra.");
    expect(expandCopies([task("n2", "ag-5", "A", "Anna Berg"), task("n2", "ag-5", "B", "Anna Berg")], [], VECKOMOTE).map((i) => [i.id, i.text])).toEqual([
      ["n2", "B"],
      ["n2-t", "B"],
    ]);
  });

  it("renderItems dedupes before planning and before building rows (v1 path too)", async () => {
    api.get.mockReset();
    api.batchUpdate.mockReset();
    const doc = anchored();
    doc.revisionId = "rev7";
    api.get.mockResolvedValue({ data: doc });
    api.batchUpdate.mockResolvedValue({ data: {} });
    const a = note("n1", "notes", "Första");
    const res = await renderItems(auth, meeting, [], [a, { ...a, text: "Andra" }], "rev7", undefined, { plan: planFormatRender, profile: VECKOMOTE, ownerLabel: ctx.ownerLabel });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.rows.map((r) => [r.id, r.text, r.last_rendered_text])).toEqual([["n1", "Andra", "Andra."]]);
    const sent = api.batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(sent.filter((r: docs_v1.Schema$Request) => r.insertText)).toHaveLength(1);
  });
});

describe("planFormatRender never merges a human paragraph into ours", () => {
  it("our removed line at the end of the tab right after a human line: its newline stays", () => {
    const n1 = note("n1", "notes", "Gammal anteckning");
    const doc = anchored(
      (d) => {
        insertAfter(d, LIVE, "Mänsklig rad.");
        insertAfter(d, "Mänsklig rad.", "Gammal anteckning.");
      },
      [["ss-m1-n1", "Gammal anteckning."]],
    );
    const ours = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Gammal anteckning.\n")!;
    const p = plan(doc, [row(n1, "Gammal anteckning.")], []);
    expect(p.requests).toEqual([
      { deleteNamedRange: { name: "ss-m1-n1", tabsCriteria: { tabIds: [TAB] } } },
      { deleteContentRange: { range: { tabId: TAB, startIndex: ours.start, endIndex: ours.end - 1 } } },
    ]);
  });

  it("after one of our own kept lines the v1 rule applies (that newline is ours)", () => {
    const n1 = note("n1", "notes", "Kvar");
    const n2 = note("n2", "notes", "Bort");
    const doc = anchored(
      (d) => {
        insertAfter(d, LIVE, "Kvar.");
        insertAfter(d, "Kvar.", "Bort.");
      },
      [["ss-m1-n1", "Kvar."], ["ss-m1-n2", "Bort."]],
    );
    const bort = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Bort.\n")!;
    const p = plan(doc, [row(n1, "Kvar."), row(n2, "Bort.")], [n1]);
    expect(p.requests).toContainEqual({ deleteContentRange: { range: { tabId: TAB, startIndex: bort.start - 1, endIndex: bort.end - 1 } } });
  });

  it("a plain line after a human bulleted line drops the inherited bullet and indent", () => {
    const doc = anchored((d) => {
      elByText(d, "Ordförande: Boka lokal.").paragraph!.bullet = { listId: "kix.tasks", nestingLevel: 0 };
    });
    const p = plan(doc, [], [task("n1-t", "tasks", "Ring banken", "Lisa Holm")]);
    const at = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === "Ordförande: Boka lokal.\n")!.end;
    expect(p.requests).toContainEqual({ deleteParagraphBullets: { range: { tabId: TAB, startIndex: at, endIndex: at + 20 } } });
    expect(p.requests).toContainEqual({
      updateParagraphStyle: {
        range: { tabId: TAB, startIndex: at, endIndex: at + 20 },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } },
        fields: "namedStyleType,indentStart,indentFirstLine",
      },
    });
  });
});

describe("planFormatRender notes and info cells", () => {
  it("notes go at the end of the notes block (after the LIVE line), NORMAL_TEXT", () => {
    const doc = anchored();
    const live = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === `${LIVE}\n`)!;
    const p = plan(doc, [], [note("n1", "notes", "Nästa möte hålls i Kårallen")]);
    expect(p.requests).toEqual([
      { insertText: { text: "\nNästa möte hålls i Kårallen.", location: { tabId: TAB, index: live.end - 1 } } },
      { updateParagraphStyle: { range: { tabId: TAB, startIndex: live.end, endIndex: live.end + 28 }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
      { createNamedRange: { name: "ss-m1-n1", range: { tabId: TAB, startIndex: live.end, endIndex: live.end + 28 } } },
      plainText(live.end, live.end + 28),
    ]);
  });

  const att: NotesItem = { id: "info-narvarande", section: "attendees", text: "Anna Berg, Erik Lund", anchor: "info.narvarande" };

  it("empty Närvarande cell → insert at its paragraphStart + range ss-m1-info-narvarande", () => {
    const p = plan(anchored(), [], [att]);
    expect(p.requests).toEqual([
      { insertText: { text: "Anna Berg, Erik Lund", location: { tabId: TAB, index: 51 } } },
      { createNamedRange: { name: "ss-m1-info-narvarande", range: { tabId: TAB, startIndex: 51, endIndex: 71 } } },
      plainText(51, 71),
    ]);
  });

  it("a Närvarande cell holding human text → no request", () => {
    const doc = anchored((d) => setCell(d, 2, "Alla"));
    const p = plan(doc, [], [att]);
    expect(p.requests).toEqual([]);
    expect(p.applied.size).toBe(0);
  });

  it("no Närvarande cell → 'Närvarande: <names>' right after the LIVE line", () => {
    const doc = anchored((d) => {
      const t = body(d).find((e) => e.table)!.table!;
      t.tableRows!.splice(2, 1);
      reindex(d);
    });
    const live = parseNotesTab(doc, TAB).paragraphs.find((x) => x.text === `${LIVE}\n`)!;
    const p = plan(doc, [], [att, note("n1", "notes", "En anteckning")]);
    expect(inserts(p)).toEqual([[live.end - 1, "\nNärvarande: Anna Berg, Erik Lund\nEn anteckning."]]);
    expect(renderedRows("m1", [], [att], p)[0].last_rendered_text).toBe("Närvarande: Anna Berg, Erik Lund");
  });

  it("once rendered in the cell: read back, a third name replaces it, a human edit in the cell locks it", () => {
    const text = "Anna Berg, Erik Lund";
    const doc = withRanges(anchored((d) => setCell(d, 2, text)), [...ANCHORS, ["ss-m1-info-narvarande", "cell:2"]]);
    const rows = [row(att, text)];
    const state = readState(parseNotesTab(doc, TAB), rows);
    expect(state.diff.rows[0]).toMatchObject({ locked: false, deleted_by_human: false, text });
    expect(state.items).toEqual([toNotesItem(rows[0])]);
    const p = plan(doc, rows, [{ ...att, text: "Anna Berg, Erik Lund, Lisa Holm" }]);
    expect(p.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-info-narvarande", text: "Anna Berg, Erik Lund, Lisa Holm", tabsCriteria: { tabIds: [TAB] } } },
    ]);
    // A human typed at the cell's start (outside our range): whole-cell diff → locked.
    const edited = withRanges(anchored((d) => setCell(d, 2, `X${text}`)), [...ANCHORS]);
    edited.tabs![0].documentTab!.namedRanges!["ss-m1-info-narvarande"] = {
      name: "ss-m1-info-narvarande",
      namedRanges: [{ name: "ss-m1-info-narvarande", ranges: [{ startIndex: 52, endIndex: 72 }] }],
    };
    const st2 = readState(parseNotesTab(edited, TAB), rows);
    expect(st2.diff.rows[0]).toMatchObject({ locked: true, text: `X${text}` });
    expect(plan(edited, rows, [{ ...att, text: "Anna Berg" }]).requests).toEqual([]);
  });

  it("Tid row (F1): '18:05' → '18:05–19:10' replaced as is, never removed", () => {
    const tid: NotesItem = { id: "info-tid", section: "note", text: "18:05", anchor: "info.tid" };
    const doc = withRanges(anchored((d) => setCell(d, 1, "18:05")), [...ANCHORS, ["ss-m1-info-tid", "cell:1"]]);
    const rows = [row(tid, "18:05")];
    const p = plan(doc, rows, [{ ...tid, text: "18:05–19:10" }]);
    expect(p.requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-info-tid", text: "18:05–19:10", tabsCriteria: { tabIds: [TAB] } } },
    ]);
    expect(renderedRows("m1", rows, [{ ...tid, text: "18:05–19:10" }], p)[0].last_rendered_text).toBe("18:05–19:10");
    expect(plan(doc, rows, []).removed.size).toBe(0);
  });
});

describe("planFormatRender ordering and the header", () => {
  it("requests are sorted by descending index and every one carries the tab id", () => {
    const anna = task("n1", "ag-5", "Mejla klubben", "Anna Berg");
    const desired = expandCopies([anna, note("n2", "ag-4", "a"), note("n3", "notes", "b"), note("n4", "ag-1", "c")], [], VECKOMOTE);
    const p = plan(anchored(), [], [...desired, { id: "info-narvarande", section: "attendees", text: "Anna", anchor: "info.narvarande" }], {
      headerText: "Simon Says antecknar live · uppdaterad 18:20",
      newAnchors: [{ key: "ag-7", start: 205, end: 211 }],
    });
    const firstIndex = (r: docs_v1.Schema$Request) =>
      r.insertText?.location?.index ?? r.createNamedRange?.range?.startIndex ?? r.updateParagraphStyle?.range?.startIndex ??
      r.deleteParagraphBullets?.range?.startIndex ?? r.createParagraphBullets?.range?.startIndex ?? null;
    // Group anchors (each group's first request) never go up.
    const firsts = p.requests.filter((r) => r.insertText && r.insertText.text !== "– " || r.replaceNamedRangeContent).map(firstIndex).filter((x): x is number => x !== null);
    expect([...firsts].sort((a, b) => b - a)).toEqual(firsts);
    for (const r of p.requests) {
      const json = JSON.stringify(r);
      expect(json.includes(`"tabId":"${TAB}"`) || json.includes(`"tabIds":["${TAB}"]`)).toBe(true);
    }
    expect(p.header).toBe("Simon Says antecknar live · uppdaterad 18:20");
  });
});

describe("renderItems with layout 'format'", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.batchUpdate.mockReset();
  });

  it("without `format` writes nothing and says so (a tick deployed before A12)", async () => {
    const rows = [row(note("n1", "ag-4", "x"), "x.")];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await renderItems(auth, meeting, rows, [note("n2", "ag-4", "y")], "REV_ID");
    expect(res).toEqual({ status: "skipped", reason: "format-planner-missing" });
    await renderItems(auth, meeting, rows, [], "REV_ID");
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("with `format` calls the injected planner and writes one guarded batch", async () => {
    const doc = anchored();
    doc.revisionId = "rev9";
    api.get.mockResolvedValue({ data: doc });
    api.batchUpdate.mockResolvedValue({ data: {} });
    const n1 = note("n1", "ag-4", "Sommarfesten blir 14 juni");
    const res = await renderItems(auth, meeting, [], [n1], "rev9", undefined, { plan: planFormatRender, profile: VECKOMOTE, ownerLabel: ctx.ownerLabel });
    expect(res.status).toBe("ok");
    const body = api.batchUpdate.mock.calls[0][0].requestBody;
    expect(body.writeControl).toEqual({ requiredRevisionId: "rev9" });
    expect(body.requests[0]).toEqual({ insertText: { text: "\nSommarfesten blir 14 juni.", location: { tabId: TAB, index: 196 } } });
    if (res.status === "ok") expect(res.rows[0]).toMatchObject({ id: "n1", anchor: "ag-4", last_rendered_text: "Sommarfesten blir 14 juni." });
  });
});
