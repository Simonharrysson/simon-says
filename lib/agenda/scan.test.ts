import { describe, expect, it } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { parseNotesTab } from "@/lib/docs/tab";
import { VECKOMOTE } from "@/lib/formats/standard";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import fixtureH3 from "@/fixtures/agenda/veckomote-h3.doc.json";
import { itemAt, normLabel, scanAgenda } from "./scan";

type Doc = docs_v1.Schema$Document;
type El = docs_v1.Schema$StructuralElement;

const clone = (d: unknown): Doc => JSON.parse(JSON.stringify(d)) as Doc;
const body = (doc: Doc): El[] => doc.tabs![0].documentTab!.body!.content!;
const textOf = (el: El) => (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
const scan = (doc: Doc) => scanAgenda(parseNotesTab(doc, "t.0"), VECKOMOTE);
const LABELS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"];

function setText(el: El, text: string) {
  el.paragraph!.elements = [{ startIndex: el.startIndex, endIndex: el.endIndex, textRun: { content: text, textStyle: {} } }];
}
function para(text: string, style = "NORMAL_TEXT", bullet?: docs_v1.Schema$Bullet): El {
  return {
    startIndex: 0,
    endIndex: 0,
    paragraph: { elements: [{ textRun: { content: text, textStyle: {} } }], paragraphStyle: { namedStyleType: style }, ...(bullet ? { bullet } : {}) },
  };
}
/** Recompute indices after editing paragraphs (tables keep their own span length). */
function reindex(doc: Doc) {
  let at = 1;
  for (const el of body(doc)) {
    if (el.sectionBreak) continue;
    const len = el.paragraph ? textOf(el).length : (el.endIndex! - el.startIndex!);
    const shift = at - (el.startIndex ?? at);
    if (el.table) {
      for (const row of el.table.tableRows ?? [])
        for (const cell of row.tableCells ?? []) {
          cell.startIndex! += shift;
          cell.endIndex! += shift;
          for (const c of cell.content ?? []) {
            c.startIndex! += shift;
            c.endIndex! += shift;
          }
        }
    }
    el.startIndex = at;
    el.endIndex = at + len;
    at += len;
  }
}
const find = (doc: Doc, text: string) => body(doc).find((el) => textOf(el) === `${text}\n`)!;

describe("normLabel", () => {
  it("lowercases, strips numbers, trailing colon/question mark and extra spaces", () => {
    expect(normLabel("Agenda:")).toBe("agenda");
    expect(normLabel("  Vad ska vi göra  till nästa gång? ")).toBe("vad ska vi göra till nästa gång");
    expect(normLabel("§1. Mötets öppnande")).toBe("mötets öppnande");
    expect(normLabel("§ 4 Övrigt")).toBe("övrigt");
    expect(normLabel("4. Kommande event")).toBe("kommande event");
    expect(normLabel("17 maj-fest")).toBe("17 maj-fest");
    expect(normLabel("Må-runda".normalize("NFD"))).toBe("må-runda");
  });
});

describe("scanAgenda on the A1 fixture", () => {
  const s = scan(clone(fixture));

  it("finds the six items in Doc order", () => {
    expect(s.items.map((i) => i.key)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6"]);
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items.every((i) => i.kind === "list" && i.level === 0)).toBe(true);
    expect(s.items[0]).toMatchObject({ paraStart: 91, paraEnd: 110, blockEnd: 110, humanText: "" });
  });

  it("gives item 4 its two sub-bullets", () => {
    const ag4 = s.items[3];
    expect(ag4.humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
    expect(ag4.blockEnd).toBe(197);
    expect(ag4.blockLimit).toBe(197);
    expect(s.items[5].blockLimit).toBe(212); // up to the tasks heading
  });

  it("reads title, info table and headings", () => {
    expect(s.title).toEqual({ start: 1, end: 17, text: "Mötesprotokoll:" });
    expect(s.agendaHeading).toEqual({ start: 83, end: 91 });
    expect(s.info.map((c) => [c.field, c.valueCell.empty])).toEqual([
      ["Datum", true],
      ["Tid", true],
      ["Närvarande", true],
      ["Sekreterare", false],
    ]);
    expect(s.info[0]).toEqual({ field: "Datum", labelCell: { start: 20, end: 27 }, valueCell: { paragraphStart: 28, empty: true, text: "" } });
    expect(s.info[3].valueCell).toEqual({ paragraphStart: 67, empty: false, text: "Elin Berglund" });
    expect(s.tasksHeading).toEqual({ start: 212, end: 245, text: "Vad ska vi göra till nästa gång?" });
    expect(s.notesHeading).toEqual({ start: 269, end: 283, text: "Anteckningar:" });
  });

  it("itemAt maps an index to the item whose block holds it", () => {
    expect(itemAt(s, 95)?.key).toBe("ag-1");
    expect(itemAt(s, 160)?.key).toBe("ag-4");
    expect(itemAt(s, 230)).toBeNull();
    expect(itemAt(s, 50)).toBeNull();
  });

  it("puts table cells into paragraphs marked inTable, so itemSpan can reach them", () => {
    const tab = parseNotesTab(clone(fixture), "t.0");
    const cell = tab.paragraphs.find((p) => p.start === 67)!;
    expect(cell).toMatchObject({ text: "Elin Berglund\n", inTable: { table: 0, row: 3, col: 1 } });
    expect(tab.paragraphs.map((p) => p.start)).toEqual([...tab.paragraphs.map((p) => p.start)].sort((a, b) => a - b));
    expect(tab.tables?.[0].rows[1].cells[1]).toEqual({ start: 35, end: 37, text: "", paragraphStart: 36 });
  });
});

describe("scanAgenda variants", () => {
  it("'Dagordning' as HEADING_1 gives the same items", () => {
    const doc = clone(fixture);
    const h = find(doc, "Agenda:");
    setText(h, "Dagordning\n");
    h.paragraph!.paragraphStyle!.namedStyleType = "HEADING_1";
    reindex(doc);
    const s = scan(doc);
    expect(s.agendaHeading).not.toBeNull();
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
  });

  it("a bold unknown line is no agenda heading (the first list starts the region); a bold sub-bullet stays inside its item", () => {
    const doc = clone(fixture);
    const h = find(doc, "Agenda:");
    setText(h, "Mötets punkter\n");
    h.paragraph!.elements![0].textRun!.textStyle = { bold: true };
    const sub = find(doc, "Sommarfest på Kårallen");
    sub.paragraph!.elements![0].textRun!.textStyle = { bold: true };
    reindex(doc);
    const s = scan(doc);
    // "Mötets punkter" is no known agenda label: no agenda heading, so the first list starts the region.
    expect(s.agendaHeading).toBeNull();
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items[3].humanText).toContain("Sommarfest");
  });

  it("items as HEADING_3 '4. Kommande event' are heading items", () => {
    const doc = clone(fixture);
    let n = 0;
    for (const el of body(doc)) {
      const b = el.paragraph?.bullet;
      if (!b || b.nestingLevel) continue;
      n++;
      setText(el, `${n}. ${textOf(el)}`);
      delete el.paragraph!.bullet;
      el.paragraph!.paragraphStyle!.namedStyleType = "HEADING_3";
    }
    reindex(doc);
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items.every((i) => i.kind === "heading")).toBe(true);
    expect(s.items[3].humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
  });

  it("the measured H3 variant: item 5 is a heading, the list continues around it", () => {
    const s = scan(clone(fixtureH3));
    expect(s.items.map((i) => [i.label, i.kind])).toEqual([
      ["Godkänn dagordning", "list"],
      ["Må-runda", "list"],
      ["Från förra veckan", "list"],
      ["Kommande event", "list"],
      ["Banbokning", "heading"],
      ["Övrigt", "list"],
    ]);
    expect(s.items[3].blockEnd).toBe(197);
  });

  it("no tasks heading → tasksHeading null, region ends at the notes heading", () => {
    const doc = clone(fixture);
    const content = body(doc);
    content.splice(content.indexOf(find(doc, "Vad ska vi göra till nästa gång?")), 1);
    reindex(doc);
    const s = scan(doc);
    expect(s.tasksHeading).toBeNull();
    expect(s.notesHeading?.text).toBe("Anteckningar:");
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items[5].humanText).toBe("Ordförande: Boka lokal.");
  });

  it("a trailing empty paragraph after item 4's sub-bullets does not move blockEnd", () => {
    const doc = clone(fixture);
    const content = body(doc);
    const sub2 = find(doc, "Workshop om sponsring");
    content.splice(content.indexOf(sub2) + 1, 0, para("\n", "NORMAL_TEXT", { listId: sub2.paragraph!.bullet!.listId, nestingLevel: 1 }), para("\n"));
    reindex(doc);
    const s = scan(doc);
    expect(s.items[3].blockEnd).toBe(sub2.endIndex);
    expect(s.items[3].blockLimit).toBe(sub2.endIndex! + 2);
    expect(s.items[3].humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
    expect(s.items).toHaveLength(6);
  });

  it("an empty Doc has no items and no headings", () => {
    const doc = clone(fixture);
    doc.tabs![0].documentTab!.body!.content = [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: "\n" } }] } }];
    const s = scan(doc);
    expect(s).toEqual({ title: null, info: [], agendaHeading: null, items: [], tasksHeading: null, notesHeading: null });
  });

  it("numbers typed as text under the agenda heading are items; other plain lines are not", () => {
    const doc = clone(fixture);
    let n = 0;
    for (const el of body(doc)) {
      const b = el.paragraph?.bullet;
      if (!b) continue;
      if (b.nestingLevel) {
        delete el.paragraph!.bullet; // sub-points typed as plain lines too
        continue;
      }
      n++;
      setText(el, `${n}. ${textOf(el)}`);
      delete el.paragraph!.bullet;
    }
    const content = body(doc);
    const ag4 = content.indexOf(find(doc, "4. Kommande event"));
    content.splice(ag4 + 1, 0, para("2026 års budget diskuteras\n"), para("4.Utan mellanslag\n"));
    reindex(doc);
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items.every((i) => i.kind === "heading")).toBe(true);
    expect(s.items[3].humanText).toBe("2026 års budget diskuteras\n4.Utan mellanslag\nSommarfest på Kårallen\nWorkshop om sponsring");
  });

  it("a list item labelled like a section heading does not end the agenda", () => {
    const doc = clone(fixture);
    setText(find(doc, "Ekonomi"), "Att göra\n");
    reindex(doc);
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual([...LABELS.slice(0, 4), "Att göra", "Övrigt"]);
    expect(s.tasksHeading?.text).toBe("Vad ska vi göra till nästa gång?");
  });
});
