import { describe, expect, it } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import h3Fixture from "@/fixtures/agenda/veckomote-h3.doc.json";
import { docOf, paraEl } from "@/test/docsim";
import { docStructure, firstNames, linePrefix, recurringOnly } from "./structure";

// Fictional agenda Docs (fixtures/agenda): "Mötesprotokoll:", a 4-row info table whose
// Sekreterare cell holds "Elin Berglund", a numbered agenda of six items where ag-4 ("Kommande
// event") has two sub-bullets, a tasks heading with "Ordförande: Boka lokal." and a notes heading.
const doc = fixture as unknown as docs_v1.Schema$Document;
const h3Doc = h3Fixture as unknown as docs_v1.Schema$Document;

/** Text of the fixture that must never leave the Doc. */
const PRIVATE = ["Sommarfest på Kårallen", "Workshop om sponsring", "Elin Berglund", "Boka lokal"];

describe("docStructure", () => {
  it("reads the fixture's structure", () => {
    const s = docStructure(doc);
    expect(s.title).toBe("Mötesprotokoll");
    expect(s.topItems).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"]);
    expect(s.tableLabels).toEqual(["Datum", "Tid", "Närvarande", "Sekreterare"]);
    expect(s.numbering).toBe("numbered");
    expect(s.nestedCounts).toEqual([0, 0, 0, 2, 0, 0]);
    expect(s.headings).toEqual([
      { level: 2, text: "Vad ska vi göra till nästa gång?" },
      { level: 1, text: "Anteckningar:" },
    ]);
    expect(s.linePrefixes).toContainEqual({ prefix: "Ordförande", count: 1 });
    expect(s.taskLines).toEqual({ total: 1, withDate: 0, withOwner: 1 });
  });

  it("privacy: no sub-bullet text, cell value or task text", () => {
    const json = JSON.stringify(docStructure(doc));
    for (const text of PRIVATE) expect(json).not.toContain(text);
    const h3 = JSON.stringify(docStructure(h3Doc));
    for (const text of PRIVATE) expect(h3).not.toContain(text);
  });

  it("an H3 topic is an item, its typed number dropped", () => {
    expect(docStructure(h3Doc).topItems).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Banbokning", "Övrigt"]);
  });

  it("§-numbered plain lines give paragraph numbering; body lines stay out", () => {
    const lines: [string, boolean][] = [
      ["Protokoll styrelsemöte", false],
      ["§1 Mötets öppnande", false],
      ["Ordföranden öppnade mötet kl 18.", false],
      ["§2 Budget för våren", true],
      ["Kassören presenterade ett hemligt förslag.", false],
      ["§3 Mötets avslutande", false],
    ];
    let at = 1;
    const content = lines.map(([text, bold]) => {
      const start = at;
      at += text.length + 1;
      return {
        startIndex: start,
        endIndex: at,
        paragraph: {
          elements: [{ startIndex: start, endIndex: at, textRun: { content: `${text}\n`, textStyle: bold ? { bold: true } : {} } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      };
    });
    const built = { tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content } } }] } as docs_v1.Schema$Document;
    const s = docStructure(built);
    expect(s.topItems).toEqual(["Mötets öppnande", "Budget för våren", "Mötets avslutande"]);
    expect(s.numbering).toBe("paragraph");
    expect(s.nestedCounts).toEqual([1, 1, 0]);
    const json = JSON.stringify(s);
    expect(json).not.toContain("hemligt");
    expect(json).not.toContain("öppnade mötet");
  });

  it("a Doc without tabs gives an empty structure", () => {
    expect(docStructure({}).topItems).toEqual([]);
  });
});

/** A 2-column table element from [label, value] rows. */
const table2 = (rows: [string, string][]): docs_v1.Schema$StructuralElement => ({
  table: { rows: rows.length, columns: 2, tableRows: rows.map(([a, b]) => ({ tableCells: [{ content: [paraEl(a)] }, { content: [paraEl(b)] }] })) },
});

describe("docStructure privacy (final review I1)", () => {
  const names = firstNames(["Elin Berglund", "Oskar Lind", "Maja Ek"]);

  it("no agenda heading, no list: body lines never become items", () => {
    const d = docOf([
      paraEl("Möte i styrelsen", { style: "TITLE" }),
      paraEl("Oskar har pratat med kommunen om bidraget"),
      paraEl("Vi tycker att 3 500 kr räcker"),
      paraEl("Maja bokar lokalen"),
    ]);
    const s = docStructure(d, { names });
    expect(s.topItems).toEqual([]);
    const json = JSON.stringify(s);
    for (const t of ["kommunen", "3 500", "Maja", "Oskar", "bokar"]) expect(json).not.toContain(t);
  });

  it("bulleted notes without an agenda heading: long, numeric or name-holding lines stay in the Doc", () => {
    const d = docOf([
      paraEl("Protokoll", { style: "TITLE" }),
      paraEl("Elin redovisade kassan för hösten", { level: 0, listId: "b" }),
      paraEl("Vi behöver 12 nya bollar till träningen", { level: 0, listId: "b" }),
      paraEl("Diskussion om att flytta träningen till torsdagar eftersom hallen är upptagen", { level: 0, listId: "b" }),
      paraEl("Ekonomi", { level: 0, listId: "b" }),
    ]);
    const s = docStructure(d, { names });
    expect(s.topItems).toEqual(["Ekonomi"]);
    expect(s.nestedCounts).toEqual([0]);
    const json = JSON.stringify(s);
    for (const t of ["Elin", "12 nya", "torsdagar"]) expect(json).not.toContain(t);
  });

  it("a roster table (names | role) gives no table labels; an info table does", () => {
    const d = docOf([
      paraEl("Protokoll", { style: "TITLE" }),
      table2([["Elin", "Kassör"], ["Oskar", "Ordförande"], ["Anders", "Ledamot"]]),
      paraEl(""),
      table2([["Datum", ""], ["Plats", ""]]),
      paraEl(""),
      paraEl("Agenda", { style: "HEADING_2" }),
      paraEl("Ekonomi", { level: 0 }),
    ]);
    const s = docStructure(d, { names });
    expect(s.tableLabels).toEqual(["Datum", "Plats"]);
    expect(JSON.stringify(s)).not.toContain("Anders");
  });

  it("a label holding a first name of the org's people never leaves", () => {
    const d = docOf([
      paraEl("Agenda", { style: "HEADING_2" }),
      paraEl("Ekonomi", { level: 0 }),
      paraEl("Majas förslag", { level: 0 }),
      paraEl("Maja: kollar hallen", {}),
    ]);
    const s = docStructure(d, { names: firstNames(["Maja Ek", "Majas Bror"]) });
    expect(s.topItems).toEqual(["Ekonomi"]);
    expect(JSON.stringify(s)).not.toContain("Maja");
  });

  it("recurringOnly: with several Docs only shared labels leave; one Doc is unchanged", () => {
    const a = docStructure(docOf([paraEl("Agenda", { style: "HEADING_2" }), paraEl("Ekonomi", { level: 0 }), paraEl("Sommarfest", { level: 0 }), paraEl("Övrigt", { level: 0 })]));
    const b = docStructure(docOf([paraEl("Agenda", { style: "HEADING_2" }), paraEl("Ekonomi", { level: 0 }), paraEl("Banbokning", { level: 0 }), paraEl("Övrigt:", { level: 0 })]));
    const [ra, rb] = recurringOnly([a, b]);
    expect(ra.topItems).toEqual(["Ekonomi", "Övrigt"]);
    expect(rb.topItems).toEqual(["Ekonomi", "Övrigt:"]);
    expect(ra.nestedCounts).toHaveLength(2);
    expect(ra.headings.map((h) => h.text)).toEqual(["Agenda"]);
    expect(recurringOnly([a])[0]).toBe(a);
  });
});

describe("linePrefix", () => {
  it("keeps short labels before a colon", () => {
    expect(linePrefix("Kassör: Mejla klubben")).toBe("Kassör");
    expect(linePrefix("Beslut: Vi köper bollar.")).toBe("Beslut");
    expect(linePrefix("Ansvarig för event: Elin")).toBe("Ansvarig för event");
  });

  it("drops long prefixes, names, times and URLs", () => {
    expect(linePrefix("Vi pratade om att vi borde: boka")).toBeNull();
    expect(linePrefix("Elin Berglund: boka lokal")).toBeNull();
    expect(linePrefix("Kl 18:00 träning")).toBeNull();
    expect(linePrefix("https://example.com")).toBeNull();
    expect(linePrefix("Ingen kolon här")).toBeNull();
  });
});
