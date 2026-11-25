import { describe, expect, it } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import h3Fixture from "@/fixtures/agenda/veckomote-h3.doc.json";
import { docStructure, linePrefix } from "./structure";

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
