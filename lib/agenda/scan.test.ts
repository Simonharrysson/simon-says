import { describe, expect, it } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { parseNotesTab } from "@/lib/docs/tab";
import { VECKOMOTE } from "@/lib/formats/standard";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import fixtureH3 from "@/fixtures/agenda/veckomote-h3.doc.json";
import { fuzzyRoles } from "./roles";
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
    expect(s.items[3].blocks).toEqual([{ start: 137, limit: 197 }]);
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

// ---------------------------------------------------------------------------------------------
// Review fix round 1 (Ruling R-A5): real weekly Doc shapes, fictional content.

const NUM = "kix.num";
const NUM2 = "kix.num2";
const DOTS = "kix.dots";
const li = (text: string, listId = NUM, level = 0) => para(`${text}\n`, "NORMAL_TEXT", { listId, nestingLevel: level });
const p = (text: string, style = "NORMAL_TEXT") => para(`${text}\n`, style);
const bold = (text: string) => {
  const el = p(text);
  el.paragraph!.elements![0].textRun!.textStyle = { bold: true };
  return el;
};
function docOf(...els: El[]): Doc {
  const levels = (g: string) => [0, 1, 2].map(() => (g === "BULLET" ? { glyphSymbol: "●" } : { glyphType: g }));
  const doc: Doc = {
    revisionId: "r",
    tabs: [
      {
        tabProperties: { tabId: "t.0" },
        documentTab: {
          body: { content: [{ endIndex: 1, sectionBreak: {} }, p("Mötesprotokoll:"), p("Agenda:"), ...els, p("Anteckningar:", "HEADING_1")] },
          lists: {
            [NUM]: { listProperties: { nestingLevels: levels("DECIMAL") } },
            [NUM2]: { listProperties: { nestingLevels: levels("DECIMAL") } },
            [DOTS]: { listProperties: { nestingLevels: levels("BULLET") } },
          },
        },
      },
    ],
  };
  reindex(doc);
  return doc;
}
const labels = (doc: Doc) => scan(doc).items.map((i) => i.label);

describe("scanAgenda: real Doc shapes (R-A5)", () => {
  it("exposes list glyph types", () => {
    const tab = parseNotesTab(docOf(li("A")), "t.0");
    expect(tab.lists?.get(NUM)?.[0]).toBe("DECIMAL");
    expect(tab.lists?.get(DOTS)?.[0]).toBe("BULLET");
    expect(parseNotesTab(clone(fixture), "t.0").lists?.get("kix.c40iceluu4t4")?.slice(0, 3)).toEqual(["DECIMAL", "ALPHA", "ROMAN"]);
  });

  it("a bold plain line under ag-2 stays in ag-2's block", () => {
    const doc = clone(fixture);
    const content = body(doc);
    content.splice(content.indexOf(find(doc, "Må-runda")) + 1, 0, bold("Beslut: alla mår bra"));
    reindex(doc);
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items[1].humanText).toBe("Beslut: alla mår bra");
    expect(s.items[1].blockEnd).toBe(s.items[2].paraStart);
  });

  it("a typed '1. …' note under ag-2 stays in ag-2's block", () => {
    const doc = clone(fixture);
    const content = body(doc);
    content.splice(content.indexOf(find(doc, "Må-runda")) + 1, 0, p("1. Vi beslutade att ses oftare"));
    reindex(doc);
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(LABELS);
    expect(s.items[1].humanText).toBe("1. Vi beslutade att ses oftare");
  });

  it("list items, a plain '<fixed label>:' item, then restarted H3 topics", () => {
    const doc = docOf(
      li("Godkänn dagordning"),
      li("Må-runda"),
      p("Från förra veckan:"),
      p("Kassören skickade fakturan."),
      p("2. Topic A", "HEADING_3"),
      li("Detalj om A", DOTS),
      p("3. Topic B", "HEADING_3"),
      p("4. Övrigt", "HEADING_3"),
    );
    const s = scan(doc);
    expect(s.items.map((i) => [i.label, i.kind])).toEqual([
      ["Godkänn dagordning", "list"],
      ["Må-runda", "list"],
      ["Från förra veckan", "heading"],
      ["Topic A", "heading"],
      ["Topic B", "heading"],
      ["Övrigt", "heading"],
    ]);
    expect(s.items[2].humanText).toBe("Kassören skickade fakturan.");
    expect(s.items[3].humanText).toBe("Detalj om A");
    expect(fuzzyRoles(s.items, VECKOMOTE.fixedAgendaItems)).toEqual({
      "ag-1": "procedural",
      "ag-2": "checkin",
      "ag-3": "followup",
      "ag-4": "topic",
      "ag-5": "topic",
      "ag-6": "other",
    });
  });

  it("an H3 repeating a list item's label continues that item, no extra item", () => {
    const doc = docOf(li("Må-runda"), li("Kommande event"), li("Övrigt"), p("2. Kommande event", "HEADING_3"), p("Sommarfesten är bokad."));
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(["Må-runda", "Kommande event", "Övrigt"]);
    const ag2 = s.items[1];
    expect(ag2.blocks).toHaveLength(2);
    expect(ag2.humanText).toBe("Sommarfesten är bokad.");
    expect(ag2.blockEnd).toBe(ag2.blocks[1].limit);
    expect(itemAt(s, ag2.blocks[1].start + 2)?.key).toBe("ag-2");
    expect(itemAt(s, s.items[2].paraStart)?.key).toBe("ag-3");
  });

  it("a heading item then a restarted numbered list: the list holds items", () => {
    const doc = docOf(li("Godkänn dagordning"), li("Må-runda"), p("3. Topic A", "HEADING_3"), li("Topic B", NUM2), li("Övrigt", NUM2));
    expect(labels(doc)).toEqual(["Godkänn dagordning", "Må-runda", "Topic A", "Topic B", "Övrigt"]);
  });

  it("a heading item then a bulleted list: sub-points of the heading item", () => {
    const doc = docOf(li("Godkänn dagordning"), li("Må-runda"), p("3. Topic A", "HEADING_3"), li("Punkt ett", DOTS), li("Punkt två", DOTS));
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(["Godkänn dagordning", "Må-runda", "Topic A"]);
    expect(s.items[2].humanText).toBe("Punkt ett\nPunkt två");
  });

  it("a bulleted list restarting after a plain 'Från förra veckan:' item gives its sub-points", () => {
    const doc = docOf(li("Godkänn dagordning"), li("Må-runda"), p("Från förra veckan:"), li("Lokalen bokad", DOTS), li("Fakturan skickad", DOTS));
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan"]);
    expect(s.items[2].humanText).toBe("Lokalen bokad\nFakturan skickad");
  });

  it("a list after a heading item with an unknown glyph type gives sub-points", () => {
    const missing = docOf(li("Må-runda"), p("2. Topic A", "HEADING_3"), li("Punkt", "kix.unknown"));
    expect(labels(missing)).toEqual(["Må-runda", "Topic A"]);
    const bare = docOf(li("Må-runda"), p("2. Topic A", "HEADING_3"), li("Punkt", NUM2));
    bare.tabs![0].documentTab!.lists![NUM2] = { listProperties: { nestingLevels: [{}] } };
    expect(parseNotesTab(bare, "t.0").lists?.get(NUM2)).toEqual(["NONE"]);
    expect(labels(bare)).toEqual(["Må-runda", "Topic A"]);
    expect(scan(bare).items[1].humanText).toBe("Punkt");
  });

  it("H1 'Agenda' followed by a plain 'Agenda:' makes no 'Agenda' item", () => {
    const doc = docOf(li("Godkänn dagordning"));
    const content = body(doc);
    const h = find(doc, "Agenda:");
    setText(h, "Agenda\n");
    h.paragraph!.paragraphStyle!.namedStyleType = "HEADING_1";
    content.splice(content.indexOf(h) + 1, 0, p("Agenda:"));
    reindex(doc);
    expect(labels(doc)).toEqual(["Godkänn dagordning"]);
  });

  it("bold-only Docs still use bold lines as items", () => {
    const doc = docOf(bold("Ekonomi"), p("Budgeten ser bra ut."), bold("Sommarfest"));
    const s = scan(doc);
    expect(s.items.map((i) => i.label)).toEqual(["Ekonomi", "Sommarfest"]);
    expect(s.items[0].humanText).toBe("Budgeten ser bra ut.");
  });
});
