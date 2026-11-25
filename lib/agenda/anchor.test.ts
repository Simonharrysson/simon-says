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

  it("role-first task lines are not signatures", () => {
    const doc = styrelse(["Sekreterare: Skicka kallelsen.", "Justerare: läsa protokollet"]);
    expect(plan(doc, STYRELSEPROTOKOLL).plan.sectionRanges.signatures).toBeUndefined();
  });
});

describe("anchoring twice (fix I2)", () => {
  const statusLines = (tab: NotesTab) => bodyLines(tab).filter((x) => paraLine(x).startsWith("Simon Says"));

  it("a Doc anchored and ended by an earlier meeting: one status line, reused; Tid ranged again", () => {
    const doc = fixtureDoc();
    apply(doc, plan(doc).plan.requests);
    // The earlier meeting ended: its status line and Tid as the final pass leaves them.
    const els = (function walk(c: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$StructuralElement[] {
      return c.flatMap((el) => [el, ...(el.table?.tableRows ?? []).flatMap((r) => (r.tableCells ?? []).flatMap((cell) => walk(cell.content ?? [])))]);
    })(doc.tabs![0].documentTab!.body!.content!);
    const set = (from: string, to: string) => {
      const el = els.find((e) => e.paragraph?.elements?.[0]?.textRun?.content === `${from}\n`)!;
      el.paragraph!.elements = [{ textRun: { content: `${to}\n`, textStyle: {} } }];
    };
    set(INITIAL_LIVE_LINE, "Simon Says · avslutat 19:10");
    set("18:05", "18:05–19:10");
    doc.tabs![0].documentTab!.namedRanges = {}; // a different meeting's ranges are irrelevant here
    reindex(doc);

    const tab = tabOf(doc);
    const p2 = planAnchoring(scanAgenda(tab, VECKOMOTE), tab, { meetingId: "m2", profile: VECKOMOTE, startedAt: new Date("2026-12-02T17:00:00Z") });
    const after = tabOf(apply(doc, p2.requests));
    expect(statusLines(after).map(paraLine)).toEqual([INITIAL_LIVE_LINE]);
    expect(rangeText(after, "ss-m2-header")).toBe(INITIAL_LIVE_LINE);
    expect(p2.rows).toEqual([expect.objectContaining({ id: "info-tid", text: "18:05–19:10", last_rendered_text: "18:05–19:10", range_name: "ss-m2-info-tid" })]);
    expect(rangeText(after, "ss-m2-info-tid")).toBe("18:05–19:10");
    // Datum (filled) untouched; no insert into the Tid cell.
    expect(scanAgenda(after, VECKOMOTE).info.map((c) => c.valueCell.text)).toEqual(["2026-11-25", "18:05–19:10", "", "Elin Berglund"]);
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

  it("a typed HH:mm in Tid is ranged, never rewritten", () => {
    // OUR_TID cannot tell a human's "18:00" from ours; anchoring only ranges it.
    const doc = fixtureDoc();
    const tidCell = doc.tabs![0].documentTab!.body!.content!.find((e) => e.table)!.table!.tableRows![1].tableCells![1];
    tidCell.content = [paraEl("18:00")];
    reindex(doc);
    const { plan: p } = plan(doc);
    expect(p.requests.some((r) => r.insertText && r.insertText.location!.index! > 30 && r.insertText.location!.index! < 45)).toBe(false);
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

  it("given roles are used as is (no Claude call)", async () => {
    api.get.mockResolvedValue({ data: fixtureDoc() });
    api.batchUpdate.mockResolvedValue({ data: { writeControl: { requiredRevisionId: "REV_2" } } });
    const res = await anchorAgenda(auth, { ...input, roles: { "ag-2": "checkin" } });
    expect(res.agendaRoles).toEqual({ "ag-2": "checkin" });
    expect(api.match).not.toHaveBeenCalled();
  });
});
