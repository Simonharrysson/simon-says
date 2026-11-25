import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";
import type { FormatProfile } from "@/lib/formats/schema";
import { apply, docOf, paraEl, reindex, TAB } from "@/test/docsim";
import fixture from "@/fixtures/agenda/veckomote.doc.json";

const api = vi.hoisted(() => ({ get: vi.fn(), batchUpdate: vi.fn(), match: vi.fn() }));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: api.get, batchUpdate: api.batchUpdate } }),
}));
vi.mock("./roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./roles")>()),
  matchFixedItems: api.match,
}));

import { planFormatRender } from "@/lib/docs/format-render";
import { itemSpan } from "@/lib/docs/notes";
import { paraBullet, paraInTable, paraLine, paraStyle, parseNotesTab, type NotesTab } from "@/lib/docs/tab";
import { AgendaShapeError, anchorAgenda, INITIAL_LIVE_LINE, planAnchoring } from "./anchor";
import { itemAt, scanAgenda } from "./scan";

type Doc = docs_v1.Schema$Document;
type Req = docs_v1.Schema$Request;

// Fixture (A1): [1,17) "Mötesprotokoll:" · table [18,82): Datum cell para 28 (empty), Tid 36 (empty),
// Närvarande 51 (empty), Sekreterare [67,81) "Elin Berglund" · [83,91) "Agenda:" · items
// [91,110) … [205,212) Övrigt · [212,245) H2 tasks · [245,269) "Ordförande: Boka lokal." · [269,283) H1 "Anteckningar:".
const ITEMS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"];
const STARTED = new Date("2026-11-25T17:05:00Z"); // 18:05 in Stockholm
const auth = {} as OAuth2Client;
const clone = (d: unknown): Doc => JSON.parse(JSON.stringify(d)) as Doc;
const fixtureDoc = () => clone(fixture);
const tabOf = (doc: Doc) => parseNotesTab(doc, TAB);
const plan = (doc: Doc, profile: FormatProfile = VECKOMOTE) => {
  const tab = tabOf(doc);
  return { tab, plan: planAnchoring(scanAgenda(tab, profile), tab, { meetingId: "m1", profile, startedAt: STARTED }) };
};
const rangeText = (tab: NotesTab, name: string) => {
  const span = itemSpan(tab, name);
  return span ? span.rangeText : null;
};
const bodyLines = (tab: NotesTab) => tab.paragraphs.filter((p) => !paraInTable(p));
const removeBody = (doc: Doc, text: string) => {
  const content = doc.tabs![0].documentTab!.body!.content!;
  const i = content.findIndex((el) => (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("") === `${text}\n`);
  if (i < 0) throw new Error(`no paragraph ${text}`);
  content.splice(i, 1);
  reindex(doc);
};

/** insertText / deleteContentRange must sit at a paragraph's end or in an empty cell of `before`. */
function assertNoWriteInsideHumanText(before: NotesTab, requests: Req[]) {
  const ends = new Set(before.paragraphs.filter((p) => !paraInTable(p)).map((p) => p.end - 1));
  const emptyCells = new Set(before.paragraphs.filter((p) => paraInTable(p) && p.text === "\n").map((p) => p.start));
  for (const r of requests) {
    expect(r.deleteContentRange).toBeUndefined();
    if (!r.insertText) continue;
    const at = r.insertText.location!.index!;
    expect(ends.has(at) || emptyCells.has(at), `insert at ${at}`).toBe(true);
  }
}

beforeEach(() => {
  api.get.mockReset();
  api.batchUpdate.mockReset();
  api.match.mockReset();
});

describe("planAnchoring on the A1 fixture", () => {
  it("ranges exactly the six items' text, the two headings and nothing human is rewritten", () => {
    const doc = fixtureDoc();
    const { tab, plan: p } = plan(doc);
    const agRanges = p.requests.filter((r) => r.createNamedRange?.name?.startsWith("ss-m1-ag-"));
    expect(agRanges).toHaveLength(6);
    const texts = agRanges.map((r) => {
      const { startIndex, endIndex } = r.createNamedRange!.range!;
      const para = tab.paragraphs.find((x) => x.start === startIndex)!;
      return para.text.slice(0, endIndex! - startIndex!) + (para.end - 1 === endIndex ? "" : "!");
    });
    expect(texts.sort()).toEqual([...ITEMS].sort());
    expect(p.sectionRanges).toMatchObject({ "ag-1": "ss-m1-ag-1", "ag-6": "ss-m1-ag-6", tasks: "ss-m1-sec-tasks", notes: "ss-m1-sec-notes" });
    expect(p.headerRange).toBe("ss-m1-header");
    expect(p.appended).toEqual([]);
    assertNoWriteInsideHumanText(tab, p.requests);
    // Sekreterare cell [66,81) untouched by any request.
    for (const r of p.requests) {
      const idx = r.insertText?.location?.index;
      if (idx != null) expect(idx < 66 || idx >= 81).toBe(true);
    }
    for (const r of p.requests) expect(JSON.stringify(r)).toContain(TAB);
  });

  it("fills empty Datum and Tid (Stockholm), Tid with its own row; Närvarande and Sekreterare untouched", () => {
    const doc = fixtureDoc();
    const { plan: p } = plan(doc);
    const inserts = p.requests.filter((r) => r.insertText).map((r) => [r.insertText!.location!.index, r.insertText!.text]);
    expect(inserts).toContainEqual([28, "2026-11-25"]);
    expect(inserts).toContainEqual([36, "18:05"]);
    expect(inserts.filter(([at]) => (at as number) < 83)).toHaveLength(2);
    expect(p.requests.filter((r) => r.createNamedRange?.name === "ss-m1-info-tid").map((r) => r.createNamedRange!.range)).toEqual([
      { tabId: TAB, startIndex: 36, endIndex: 41 },
    ]);
    expect(p.requests.some((r) => r.createNamedRange?.range?.startIndex === 28)).toBe(false);
    expect(p.rows).toEqual([
      expect.objectContaining({
        id: "info-tid",
        section: "note",
        kind: "note",
        anchor: "info.tid",
        range_name: "ss-m1-info-tid",
        last_rendered_text: "18:05",
        locked: false,
      }),
    ]);
  });

  it("requests run from the highest index down", () => {
    const { plan: p } = plan(fixtureDoc());
    const idx = p.requests.filter((r) => r.insertText || r.createNamedRange).map((r) => r.insertText?.location?.index ?? r.createNamedRange!.range!.startIndex!);
    // Each insert group's own ranges follow it (higher than the insert), so compare inserts only.
    const inserts = p.requests.filter((r) => r.insertText).map((r) => r.insertText!.location!.index!);
    expect([...inserts].sort((a, b) => b - a)).toEqual(inserts);
    expect(idx.length).toBeGreaterThan(inserts.length);
  });

  it("applied: LIVE line right under Anteckningar as NORMAL_TEXT in its range, items intact, cells filled", () => {
    const doc = fixtureDoc();
    const { tab: before, plan: p } = plan(doc);
    const after = tabOf(apply(doc, p.requests));
    const lines = bodyLines(after);
    const notes = lines.findIndex((x) => paraLine(x) === "Anteckningar:");
    expect(paraLine(lines[notes + 1])).toBe(INITIAL_LIVE_LINE);
    expect(paraStyle(lines[notes + 1])).toBe("NORMAL_TEXT");
    expect(paraStyle(lines[notes])).toBe("HEADING_1");
    expect(rangeText(after, "ss-m1-header")).toBe(INITIAL_LIVE_LINE);
    ITEMS.forEach((label, i) => expect(rangeText(after, `ss-m1-ag-${i + 1}`)).toBe(label));
    expect(rangeText(after, "ss-m1-sec-tasks")).toBe("Vad ska vi göra till nästa gång?");
    expect(rangeText(after, "ss-m1-sec-notes")).toBe("Anteckningar:");
    expect(rangeText(after, "ss-m1-info-tid")).toBe("18:05");
    // Every human paragraph's text is unchanged (only empty cells gained text).
    const human = before.paragraphs.map((x) => x.text).filter((t) => t !== "\n");
    const now = after.paragraphs.map((x) => x.text);
    for (const t of human) expect(now).toContain(t);
    const scan = scanAgenda(after, VECKOMOTE);
    expect(scan.items.map((i) => i.label)).toEqual(ITEMS);
    expect(scan.info.map((c) => c.valueCell.text)).toEqual(["2026-11-25", "18:05", "", "Elin Berglund"]);
    // The LIVE line is outside every agenda item.
    expect(itemAt(scan, itemSpan(after, "ss-m1-header")!.paraStart)).toBeNull();
  });

  it("without the tasks heading: appended at the end as HEADING_2 after the LIVE line", () => {
    const doc = fixtureDoc();
    removeBody(doc, "Vad ska vi göra till nästa gång?");
    const { plan: p, tab } = plan(doc);
    expect(p.appended).toEqual(["Vad ska vi göra till nästa gång?"]);
    const end = bodyLines(tab).at(-1)!.end - 1;
    const atEnd = p.requests.filter((r) => r.insertText?.location?.index === end);
    expect(atEnd).toHaveLength(1);
    expect(atEnd[0].insertText!.text!.endsWith("\nVad ska vi göra till nästa gång?")).toBe(true);
    assertNoWriteInsideHumanText(tab, p.requests);
    const after = tabOf(apply(doc, p.requests));
    const lines = bodyLines(after).map((x) => [paraLine(x), paraStyle(x)]);
    expect(lines.slice(-3)).toEqual([
      ["Anteckningar:", "HEADING_1"],
      [INITIAL_LIVE_LINE, "NORMAL_TEXT"],
      ["Vad ska vi göra till nästa gång?", "HEADING_2"],
    ]);
    expect(rangeText(after, "ss-m1-sec-tasks")).toBe("Vad ska vi göra till nästa gång?");
  });

  it("a Doc ending in the agenda list: headings and LIVE appended, not list items, LIVE outside every item", () => {
    const doc = fixtureDoc();
    for (const t of ["Vad ska vi göra till nästa gång?", "Ordförande: Boka lokal.", "Anteckningar:"]) removeBody(doc, t);
    const { plan: p, tab } = plan(doc);
    expect(p.appended).toEqual(["Vad ska vi göra till nästa gång?", "Anteckningar"]);
    expect(p.requests.some((r) => r.deleteParagraphBullets)).toBe(true);
    assertNoWriteInsideHumanText(tab, p.requests);
    const after = tabOf(apply(doc, p.requests));
    const tail = bodyLines(after).slice(-4);
    expect(tail.map((x) => [paraLine(x), paraStyle(x), paraBullet(x)])).toEqual([
      ["Övrigt", "NORMAL_TEXT", expect.objectContaining({ level: 0 })],
      ["Vad ska vi göra till nästa gång?", "HEADING_2", null],
      ["Anteckningar", "HEADING_2", null],
      [INITIAL_LIVE_LINE, "NORMAL_TEXT", null],
    ]);
    const scan = scanAgenda(after, VECKOMOTE);
    expect(scan.items.map((i) => i.label)).toEqual(ITEMS);
    expect(scan.tasksHeading?.text).toBe("Vad ska vi göra till nästa gång?");
    expect(itemAt(scan, itemSpan(after, "ss-m1-header")!.paraStart)).toBeNull();
  });

  it("a profile with neither section still gets a notes heading above the LIVE line", () => {
    const doc = fixtureDoc();
    for (const t of ["Vad ska vi göra till nästa gång?", "Ordförande: Boka lokal.", "Anteckningar:"]) removeBody(doc, t);
    const bare: FormatProfile = { ...VECKOMOTE, tasksSection: null, notesSection: null };
    const { plan: p } = plan(doc, bare);
    expect(p.appended).toEqual(["Anteckningar"]);
    const after = tabOf(apply(doc, p.requests));
    const scan = scanAgenda(after, bare);
    expect(scan.items).toHaveLength(6);
    expect(itemAt(scan, itemSpan(after, "ss-m1-header")!.paraStart)).toBeNull();
    expect(bodyLines(after).slice(-2).map(paraLine)).toEqual(["Anteckningar", INITIAL_LIVE_LINE]);
  });
});

describe("Styrelseprotokoll: signatures", () => {
  const styrelseDoc = () =>
    docOf([
      paraEl("Styrelseprotokoll", { style: "HEADING_1" }),
      paraEl("Dagordning", { style: "HEADING_2" }),
      ...["Mötets öppnande", "Val av justerare", "Övriga punkter", "Mötets avslutande"].map((l, i) => paraEl(`§${i + 1} ${l}`, { style: "HEADING_3" })),
      paraEl("Att göra", { style: "HEADING_2" }),
      paraEl("Mötesordförande: ____________________"),
      paraEl("Mötessekreterare: ____________________"),
      paraEl("Justerare: ____________________"),
    ]);

  it("ranges the first signature line; LIVE at the end; a Justerare task lands above the signatures", () => {
    const doc = styrelseDoc();
    const { plan: p } = plan(doc, STYRELSEPROTOKOLL);
    expect(p.sectionRanges.signatures).toBe("ss-m1-sec-signatures");
    expect(p.appended).toEqual([]);
    const after = tabOf(apply(doc, p.requests));
    expect(rangeText(after, "ss-m1-sec-signatures")).toBe("Mötesordförande: ____________________");
    expect(bodyLines(after).at(-1) && paraLine(bodyLines(after).at(-1)!)).toBe(INITIAL_LIVE_LINE);

    const meeting = {
      id: "m1",
      notes_tab_id: TAB,
      header_range: p.headerRange,
      header_rendered: INITIAL_LIVE_LINE,
      section_ranges: p.sectionRanges,
      layout: "format",
    } as unknown as MeetingRow;
    const rendered = planFormatRender(
      meeting,
      after,
      [] as NoteItemRow[],
      [{ id: "n1", section: "action", text: "Skicka protokollet", owner: "Justerare", anchor: "tasks" }],
      { profile: STYRELSEPROTOKOLL, ownerLabel: (o) => o },
    );
    const ins = rendered.requests.find((r) => r.insertText)!;
    const tasksHeading = bodyLines(after).find((x) => paraLine(x) === "Att göra")!;
    expect(ins.insertText!.location!.index).toBe(tasksHeading.end - 1);
    expect(ins.insertText!.text).toBe("\nJusterare: Skicka protokollet.");
  });

  it("a task line 'Justerare: …' is not taken for a signature", () => {
    const doc = docOf([
      paraEl("Dagordning", { style: "HEADING_2" }),
      paraEl("§1 Mötets öppnande", { style: "HEADING_3" }),
      paraEl("Att göra", { style: "HEADING_2" }),
      paraEl("Justerare: Skicka protokollet."),
    ]);
    expect(plan(doc, STYRELSEPROTOKOLL).plan.sectionRanges.signatures).toBeUndefined();
  });
});

describe("signature lines as humans type them (fix I1)", () => {
  const styrelse = (tail: string[]) =>
    docOf([
      paraEl("Dagordning", { style: "HEADING_2" }),
      paraEl("§1 Mötets öppnande", { style: "HEADING_3" }),
      paraEl("§2 Övriga frågor", { style: "HEADING_3" }),
      paraEl("Att göra", { style: "HEADING_2" }),
      paraEl("Ordförande: Boka lokal."),
      ...tail.map((t) => paraEl(t)),
    ]);
  const taskLands = (doc: Doc) => {
    const { plan: p } = plan(doc, STYRELSEPROTOKOLL);
    const after = tabOf(apply(doc, p.requests));
    const meeting = { id: "m1", notes_tab_id: TAB, header_range: p.headerRange, header_rendered: INITIAL_LIVE_LINE, section_ranges: p.sectionRanges, layout: "format" } as unknown as MeetingRow;
    const r = planFormatRender(meeting, after, [], [{ id: "n1", section: "action", text: "Betala hyran", owner: "Kassör", anchor: "tasks" }], { profile: STYRELSEPROTOKOLL, ownerLabel: (o) => o });
    const at = r.requests.find((x) => x.insertText)!.insertText!.location!.index!;
    return { p, at, boka: bodyLines(after).find((x) => paraLine(x) === "Ordförande: Boka lokal.")! };
  };

  it("names typed after the colon: still anchored, tasks stay above", () => {
    const doc = styrelse(["", "Mötesordförande: Anna Svensson", "Mötessekreterare: Bo Karlsson", "Justerare: Cecilia Lund"]);
    const { p, at, boka } = taskLands(doc);
    expect(p.sectionRanges.signatures).toBe("ss-m1-sec-signatures");
    expect(at).toBe(boka.end - 1);
  });

  it("no colon ('Ordförande ________'): anchored at the first line", () => {
    const doc = styrelse(["Ordförande ________", "Sekreterare ________"]);
    const tab = tabOf(doc);
    const { plan: p } = plan(doc, STYRELSEPROTOKOLL);
    const req = p.requests.find((r) => r.createNamedRange?.name === "ss-m1-sec-signatures")!;
    const first = bodyLines(tab).find((x) => paraLine(x) === "Ordförande ________")!;
    expect(req.createNamedRange!.range!.startIndex).toBe(first.start);
  });

  it("names with particles, and a filled line without a colon", () => {
    expect(taskLands(styrelse(["Mötesordförande: Bo af Klint", "Justerare: Anna von der Linden"])).p.sectionRanges.signatures).toBeDefined();
    const doc = styrelse(["Ordförande Anna Svensson", "Sekreterare Bo Karlsson"]);
    const { p, at, boka } = taskLands(doc);
    expect(p.sectionRanges.signatures).toBeDefined();
    expect(at).toBe(boka.end - 1);
  });

  it("a single capitalised word is no name: 'Justerare: Kallelse' as the last line is not anchored", () => {
    expect(plan(styrelse(["Justerare: Kallelse"]), STYRELSEPROTOKOLL).plan.sectionRanges.signatures).toBeUndefined();
  });

  it("a lone signature line is anchored, also when re-anchored after our appended heading and status line", () => {
    const single: FormatProfile = { ...STYRELSEPROTOKOLL, signatures: ["Justerare"] };
    const doc = docOf([
      paraEl("Dagordning", { style: "HEADING_2" }),
      paraEl("§1 Mötets öppnande", { style: "HEADING_3" }),
      paraEl("Justerare: ____________________"),
    ]);
    const first = plan(doc, single).plan;
    expect(first.appended).toEqual(["Att göra"]);
    expect(first.sectionRanges.signatures).toBeDefined();
    apply(doc, first.requests);
    const tab = tabOf(doc);
    expect(bodyLines(tab).slice(-3).map(paraLine)).toEqual(["Justerare: ____________________", "Att göra", INITIAL_LIVE_LINE]);
    const again = planAnchoring(scanAgenda(tab, single), tab, { meetingId: "m2", profile: single, startedAt: STARTED });
    expect(again.sectionRanges.signatures).toBe("ss-m2-sec-signatures");
  });

  it("role-first task lines are not signatures", () => {
    const doc = styrelse(["Sekreterare: Skicka kallelsen.", "Justerare: läsa protokollet"]);
    expect(plan(doc, STYRELSEPROTOKOLL).plan.sectionRanges.signatures).toBeUndefined();
  });
});

describe("anchoring twice (fix I2, round 2)", () => {
  const statusLines = (tab: NotesTab) => bodyLines(tab).filter((x) => paraLine(x).startsWith("Simon Says"));
  const allEls = (doc: Doc) =>
    (function walk(c: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$StructuralElement[] {
      return c.flatMap((el) => [el, ...(el.table?.tableRows ?? []).flatMap((r) => (r.tableCells ?? []).flatMap((cell) => walk(cell.content ?? [])))]);
    })(doc.tabs![0].documentTab!.body!.content!);
  const elOf = (doc: Doc, text: string) => allEls(doc).find((e) => e.paragraph?.elements?.[0]?.textRun?.content === `${text}\n`)!;
  /** Set a paragraph's text and put one named range over [offset, offset+len) of it (indices recomputed). */
  function rewrite(doc: Doc, from: string, to: string, range?: { name: string; offset: number; len: number }) {
    const el = elOf(doc, from);
    el.paragraph!.elements = [{ textRun: { content: `${to}\n`, textStyle: {} } }];
    reindex(doc);
    if (range) {
      const start = el.startIndex! + range.offset;
      doc.tabs![0].documentTab!.namedRanges![range.name] = {
        name: range.name,
        namedRanges: [{ name: range.name, namedRangeId: `id-${range.name}`, ranges: [{ startIndex: start, endIndex: start + range.len }] }],
      };
    }
  }
  /** The fixture as an ended earlier meeting "old" left it: status line and Tid in our ranges. */
  function endedDoc(status = "Simon Says · avslutat 19:10", statusLen = status.length) {
    const doc = fixtureDoc();
    apply(doc, plan(doc).plan.requests);
    doc.tabs![0].documentTab!.namedRanges = {};
    rewrite(doc, "18:05", "18:05–19:10", { name: "ss-old-info-tid", offset: 0, len: "18:05–19:10".length });
    rewrite(doc, INITIAL_LIVE_LINE, status, { name: "ss-old-header", offset: 0, len: statusLen });
    return doc;
  }
  const anchorAs = (doc: Doc, meetingId: string, startedAt = new Date("2026-12-02T17:00:00Z")) => {
    const tab = tabOf(doc);
    return { tab, p: planAnchoring(scanAgenda(tab, VECKOMOTE), tab, { meetingId, profile: VECKOMOTE, startedAt }) };
  };

  it("a Doc left by an ended meeting: one status line, reset; our old Tid rewritten with this start (18:00)", () => {
    const doc = endedDoc();
    const { p } = anchorAs(doc, "m2");
    const after = tabOf(apply(doc, p.requests));
    expect(statusLines(after).map(paraLine)).toEqual([INITIAL_LIVE_LINE]);
    expect(rangeText(after, "ss-m2-header")).toBe(INITIAL_LIVE_LINE);
    expect(p.rows).toEqual([expect.objectContaining({ id: "info-tid", text: "18:00", last_rendered_text: "18:00", range_name: "ss-m2-info-tid" })]);
    expect(rangeText(after, "ss-m2-info-tid")).toBe("18:00");
    // Datum (a human may have changed it; no range proves it ours) untouched.
    expect(scanAgenda(after, VECKOMOTE).info.map((c) => c.valueCell.text)).toEqual(["2026-11-25", "18:00", "", "Elin Berglund"]);
  });

  it("text a human added after our status range survives; only the range's text is replaced", () => {
    const doc = endedDoc("Simon Says · avslutat 19:10 (bra möte!)", "Simon Says · avslutat 19:10".length);
    const { p } = anchorAs(doc, "m2");
    const after = tabOf(apply(doc, p.requests));
    expect(statusLines(after).map(paraLine)).toEqual([`${INITIAL_LIVE_LINE} (bra möte!)`]);
    expect(rangeText(after, "ss-m2-header")).toBe(INITIAL_LIVE_LINE);
  });

  it("a human typed inside our status range: not deleted, a fresh status line is added", () => {
    const status = "Simon Says · avslutat 19:10 OBS ny tid";
    const doc = endedDoc(status, status.length); // the range grew with the typing
    const { p } = anchorAs(doc, "m2");
    const after = tabOf(apply(doc, p.requests));
    expect(p.requests.some((r) => r.deleteContentRange && r.deleteContentRange.range!.endIndex! - r.deleteContentRange.range!.startIndex! === status.length)).toBe(false);
    expect(statusLines(after).map(paraLine).sort()).toEqual([INITIAL_LIVE_LINE, status].sort());
    expect(rangeText(after, "ss-m2-header")).toBe(INITIAL_LIVE_LINE);
  });

  it("a human edit of our Tid out of our form ('18:05 ca') is never rewritten", () => {
    const doc = endedDoc();
    doc.tabs![0].documentTab!.namedRanges!["ss-old-info-tid"] = { name: "ss-old-info-tid", namedRanges: [] };
    rewrite(doc, "18:05–19:10", "18:05 ca", { name: "ss-old-info-tid", offset: 0, len: "18:05 ca".length });
    const { p } = anchorAs(doc, "m2");
    expect(p.rows).toEqual([]);
    const after = tabOf(apply(doc, p.requests));
    expect(scanAgenda(after, VECKOMOTE).info[1].valueCell.text).toBe("18:05 ca");
  });

  it("without a range: reused only when the paragraph is exactly a status form", () => {
    const exact = endedDoc();
    exact.tabs![0].documentTab!.namedRanges = {};
    const a = tabOf(apply(exact, anchorAs(exact, "m2").p.requests));
    expect(statusLines(a).map(paraLine)).toEqual([INITIAL_LIVE_LINE]);

    const edited = endedDoc("Simon Says · avslutat 19:10 – Anna tog över");
    edited.tabs![0].documentTab!.namedRanges = {};
    const b = tabOf(apply(edited, anchorAs(edited, "m2").p.requests));
    expect(statusLines(b).map(paraLine)).toEqual([INITIAL_LIVE_LINE, "Simon Says · avslutat 19:10 – Anna tog över"]);
  });

  it("the same meeting anchored twice: every range once, one status line, Tid still ours", () => {
    const doc = fixtureDoc();
    apply(doc, plan(doc).plan.requests);
    const { plan: again } = plan(doc);
    expect(again.requests.filter((r) => r.deleteNamedRange).length).toBeGreaterThan(0);
    const after = tabOf(apply(doc, again.requests));
    for (const [name, entries] of after.ranges) if (name.startsWith("ss-m1-")) expect(entries, name).toHaveLength(1);
    expect(statusLines(after)).toHaveLength(1);
    expect(rangeText(after, "ss-m1-header")).toBe(INITIAL_LIVE_LINE);
    expect(rangeText(after, "ss-m1-info-tid")).toBe("18:05");
    expect(again.rows.map((r) => r.id)).toEqual(["info-tid"]);
    ITEMS.forEach((label, i) => expect(rangeText(after, `ss-m1-ag-${i + 1}`)).toBe(label));
  });

  it("a human's typed Tid ('18:00', no range of ours) is never claimed nor rewritten", () => {
    const doc = fixtureDoc();
    const tidCell = doc.tabs![0].documentTab!.body!.content!.find((e) => e.table)!.table!.tableRows![1].tableCells![1];
    tidCell.content = [paraEl("18:00")];
    reindex(doc);
    const { plan: p } = plan(doc);
    expect(p.rows).toEqual([]);
    expect(p.requests.some((r) => r.createNamedRange?.name?.endsWith("info-tid"))).toBe(false);
    const cell = tabOf(doc).paragraphs.find((x) => x.text === "18:00\n")!;
    for (const r of p.requests) {
      const at = r.insertText?.location?.index ?? r.deleteContentRange?.range?.startIndex;
      if (at != null) expect(at < cell.start || at >= cell.end).toBe(true);
    }
    expect(scanAgenda(tabOf(apply(doc, p.requests)), VECKOMOTE).info[1].valueCell.text).toBe("18:00");
  });
});

describe("anchorAgenda", () => {
  const conflict = Object.assign(new Error("Required revision_id does not match the latest revision."), { status: 400 });
  const input = { meetingId: "m1", orgId: "o1", docId: "d1", profile: VECKOMOTE, startedAt: STARTED };

  it("an empty Doc → AgendaShapeError no_items, nothing written", async () => {
    api.get.mockResolvedValue({ data: docOf([paraEl("")]) });
    const err = await anchorAgenda(auth, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgendaShapeError);
    expect((err as AgendaShapeError).code).toBe("no_items");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("a revision conflict once → two reads, two guarded writes, then success; roles matched once", async () => {
    api.get.mockImplementation(async () => ({ data: fixtureDoc() }));
    api.batchUpdate.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ data: { writeControl: { requiredRevisionId: "REV_2" } } });
    api.match.mockResolvedValue({ "ag-1": "procedural" });
    const res = await anchorAgenda(auth, input, { sleep: async () => {} });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.batchUpdate).toHaveBeenCalledTimes(2);
    for (const call of api.batchUpdate.mock.calls) {
      expect(call[0].requestBody.writeControl).toEqual({ requiredRevisionId: "REV_ID" });
    }
    expect(api.match).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      tabId: TAB,
      revisionId: "REV_2",
      headerRange: "ss-m1-header",
      headerRendered: INITIAL_LIVE_LINE,
      agendaRoles: { "ag-1": "procedural" },
      appended: [],
    });
    expect(res.rows.map((r) => r.id)).toEqual(["info-tid"]);
    expect(res.scan.items).toHaveLength(6);
  });

  it("a Doc with two agenda headings (several weeks) → AgendaShapeError several_agendas, nothing written", async () => {
    api.get.mockResolvedValue({
      data: docOf([paraEl("Agenda", { style: "HEADING_2" }), paraEl("Ekonomi", { level: 0 }), paraEl("Dagordning", { style: "HEADING_2" }), paraEl("Banbokning", { level: 0 })]),
    });
    const err = await anchorAgenda(auth, input).catch((e: unknown) => e);
    expect((err as AgendaShapeError).code).toBe("several_agendas");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("probe: a Doc used again keeps its bold items; the earlier meeting's bullet lines are no items", async () => {
    const bold = (text: string) => paraEl(text, { bold: true });
    const doc = docOf([
      paraEl("Agenda", { style: "HEADING_2" }),
      bold("Ekonomi"),
      paraEl("Budgeten håller.", { level: 0, listId: "kix.ours" }),
      paraEl("– Kassan stämmer."),
      bold("Sommarfest"),
      paraEl("Anteckningar", { style: "HEADING_2" }),
    ]);
    doc.tabs![0].documentTab!.lists!["kix.ours"] = { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } };
    // Meeting A's ranges: its agenda anchors, its ● line (written before the fix) and a "– " line.
    const t0 = tabOf(doc);
    const at = (text: string) => t0.paragraphs.find((x) => x.text === `${text}\n`)!;
    const nr = (name: string, text: string) => ({ createNamedRange: { name, range: { tabId: TAB, startIndex: at(text).start, endIndex: at(text).end - 1 } } });
    apply(doc, [nr("ss-A-ag-1", "Ekonomi"), nr("ss-A-ag-2", "Sommarfest"), nr("ss-A-n1", "Budgeten håller."), nr("ss-A-n2", "– Kassan stämmer.")]);
    // Without the strip the start rules would see a list and drop the bold items.
    expect(scanAgenda(tabOf(doc), VECKOMOTE).items.map((i) => i.label)).toEqual(["Budgeten håller."]);
    api.get.mockImplementation(async () => ({ data: clone(doc) }));
    api.batchUpdate.mockResolvedValue({ data: { writeControl: { requiredRevisionId: "REV_2" } } });
    const res = await anchorAgenda(auth, { ...input, meetingId: "B", roles: {} });
    expect(res.scan.items.map((i) => [i.key, i.label, i.humanText])).toEqual([
      ["ag-1", "Ekonomi", ""],
      ["ag-2", "Sommarfest", ""],
    ]);
  });

  it("given roles are used as is (no Claude call)", async () => {
    api.get.mockResolvedValue({ data: fixtureDoc() });
    api.batchUpdate.mockResolvedValue({ data: { writeControl: { requiredRevisionId: "REV_2" } } });
    const res = await anchorAgenda(auth, { ...input, roles: { "ag-2": "checkin" } });
    expect(res.agendaRoles).toEqual({ "ag-2": "checkin" });
    expect(api.match).not.toHaveBeenCalled();
  });
});

describe("removing our line next to a table (final review R1-I2)", () => {
  const table2 = (): docs_v1.Schema$StructuralElement => ({
    table: { rows: 1, columns: 2, tableRows: [{ tableCells: [{ content: [paraEl("Belopp")] }, { content: [paraEl("1 200 kr")] }] }] },
  });
  const meetingFor = (ranges: Record<string, string>) =>
    ({ id: "m1", notes_tab_id: TAB, header_range: null, header_rendered: null, section_ranges: ranges, layout: "format" }) as unknown as MeetingRow;
  const ours = (id: string, text: string, anchor: string): NoteItemRow =>
    ({
      meeting_id: "m1", id, section: "note", text, owner: null, due: null, locked: false, deleted_by_human: false,
      last_rendered_text: text, range_name: `ss-m1-${id}`, position: 0, anchor, copy_of: null,
    }) as NoteItemRow;
  const nr = (doc: Doc, name: string, text: string) => {
    const p = tabOf(doc).paragraphs.find((x) => x.text === `${text}\n`)!;
    return { createNamedRange: { name, range: { tabId: TAB, startIndex: p.start, endIndex: p.end - 1 } } };
  };

  it("docsim refuses the newline before a table, as the API does (measured)", () => {
    const doc = docOf([paraEl("Rubrik"), paraEl("Vår rad"), table2(), paraEl("Efter")]);
    const p = tabOf(doc).paragraphs.find((x) => x.text === "Vår rad\n")!;
    expect(() => apply(clone(doc), [{ deleteContentRange: { range: { tabId: TAB, startIndex: p.start, endIndex: p.end } } }])).toThrow(/newline before a table/);
    const after = apply(clone(doc), [{ deleteContentRange: { range: { tabId: TAB, startIndex: p.start, endIndex: p.end - 1 } } }]);
    expect(bodyLines(tabOf(after)).map(paraLine)).toEqual(["Rubrik", "", "Efter"]);
    // Across paragraphs: merged, the first paragraph's style kept.
    const two = docOf([paraEl("Rubrik", { style: "HEADING_3" }), paraEl("Mitten"), paraEl("Slut")]);
    const [a, , c] = bodyLines(tabOf(two));
    const merged = apply(two, [{ deleteContentRange: { range: { tabId: TAB, startIndex: a.end - 1, endIndex: c.start } } }]);
    expect(bodyLines(tabOf(merged)).map((x) => [paraLine(x), paraStyle(x)])).toEqual([["RubrikSlut", "HEADING_3"]]);
  });

  it("our line right before a table: only its text goes; every later batch still applies", () => {
    const doc = docOf([
      paraEl("Agenda", { style: "HEADING_2" }),
      paraEl("Ekonomi", { level: 0 }),
      paraEl("– Gammal rad."),
      table2(),
      paraEl("Övrigt", { level: 0 }),
      paraEl("Anteckningar", { style: "HEADING_2" }),
    ]);
    apply(doc, [nr(doc, "ss-m1-ag-1", "Ekonomi"), nr(doc, "ss-m1-ag-2", "Övrigt"), nr(doc, "ss-m1-sec-notes", "Anteckningar"), nr(doc, "ss-m1-n1", "– Gammal rad.")]);
    const m = meetingFor({ "ag-1": "ss-m1-ag-1", "ag-2": "ss-m1-ag-2", notes: "ss-m1-sec-notes" });
    const rows = [ours("n1", "– Gammal rad.", "ag-1")];
    const p = planFormatRender(m, tabOf(doc), rows, [{ id: "n2", section: "note", text: "Ny rad", anchor: "ag-2" }], { profile: VECKOMOTE, ownerLabel: (o) => o });
    expect(p.removed).toEqual(new Set(["n1"]));
    const after = tabOf(apply(doc, p.requests));
    expect(bodyLines(after).map(paraLine)).toEqual(["Agenda", "Ekonomi", "", "Övrigt", "– Ny rad.", "Anteckningar"]);
    expect(after.ranges.has("ss-m1-n1")).toBe(false);
  });

  it("our last line right after a table at the end of the tab: only its text goes", () => {
    const doc = docOf([
      paraEl("Agenda", { style: "HEADING_2" }),
      paraEl("Ekonomi", { level: 0 }),
      paraEl("Anteckningar", { style: "HEADING_2" }),
      table2(),
      paraEl("Vår sista rad."),
    ]);
    apply(doc, [nr(doc, "ss-m1-ag-1", "Ekonomi"), nr(doc, "ss-m1-sec-notes", "Anteckningar"), nr(doc, "ss-m1-n1", "Vår sista rad.")]);
    const m = meetingFor({ "ag-1": "ss-m1-ag-1", notes: "ss-m1-sec-notes" });
    const p = planFormatRender(m, tabOf(doc), [ours("n1", "Vår sista rad.", "notes")], [], { profile: VECKOMOTE, ownerLabel: (o) => o });
    const after = tabOf(apply(doc, p.requests));
    expect(bodyLines(after).map(paraLine)).toEqual(["Agenda", "Ekonomi", "Anteckningar", ""]);
  });
});
