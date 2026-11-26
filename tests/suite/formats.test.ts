import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { EnvOverride } from "@/test/suite-db";

// Feature 1: document formats. A scripted meeting in each format renders into a docsim Doc, and
// the final Doc's shape is asserted: items under the right anchors, the tasks section by role or
// person, the info table, the "avslutat" line, human text untouched.

const envOverride = vi.hoisted(() => ({}) as EnvOverride);
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const base = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
  });
  return { ...mod, getEnv: () => ({ ...base, ...envOverride }) };
});
// The one-shot calls (format learning, stadgar) check today's spend and record usage in the DB:
// offline (pure tests) both are stubbed; with `offline.on` false they are the real ones.
const offline = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/db/usage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/db/usage")>();
  return { ...mod, dayUsd: async () => (offline.on ? 0 : mod.dayUsd()) };
});
vi.mock("@/lib/db/claude-usage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/db/claude-usage")>();
  return { ...mod, recordClaudeUsage: async (...a: Parameters<typeof mod.recordClaudeUsage>) => (offline.on ? undefined : mod.recordClaudeUsage(...a)) };
});

const tick = await import("@/lib/meetings/tick");
const { FormatSim, V1Sim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { fixtureDoc, linesOf, FMT_ENDED } = await import("@/test/formatdoc");
const { VECKOMOTE, STYRELSEPROTOKOLL, ENKEL } = await import("@/lib/formats/standard");
const { proposeFormat } = await import("@/lib/formats/learn");
const { extractRequiredItems } = await import("@/lib/formats/stadgar");
const { docStructure } = await import("@/lib/formats/structure");
const { docOf, paraEl, TAB } = await import("@/test/docsim");
const { anchoredStarts, scanAgenda } = await import("@/lib/agenda/scan");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const db = await import("@/test/suite-db");

type Doc = docs_v1.Schema$Document;

/** `sub` appears in `all` in the same order (human lines kept, in place). */
function isSubsequence(sub: string[], all: string[]): boolean {
  let i = 0;
  for (const line of all) if (i < sub.length && line === sub[i]) i++;
  return i === sub.length;
}

const PEOPLE = [
  { name: "Anna Berg", role: "Kassör" },
  { name: "Erik Lund", role: null },
  { name: "Maja Holm", role: "Ordförande" },
];
const CLOSED = { startMs: 2000, endMs: 60_000, closed: true, failures: 0 };

// Fictional Veckomöte of a fictional förening: three ticks, then the final pass.
const VECKOMOTE_SCRIPT = notesTicks([
  [
    { op: "add", id: "x1", kind: "decision", anchor: "ag-4", text: "Sommarfesten hålls lördag 14 juni" },
    { op: "add", id: "x2", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg", due: "fredag" },
  ],
  [
    { op: "add", id: "x3", kind: "note", anchor: "ag-5", text: "Kassan är 12 000 kr" },
    { op: "add", id: "x4", kind: "task", anchor: "ag-6", text: "Skicka ut kallelsen till nästa möte", owner: "Erik" },
  ],
  [{ op: "add", id: "x5", kind: "note", anchor: "notes", text: "Nästa möte hålls på distans" }],
  [{ op: "change", id: "n1", text: "Sommarfesten hålls lördag 14 juni på Kårallen" }],
]);

describe("feature: formats (document formats)", () => {
  afterEach(() => {
    offline.on = false;
  });

  it("Veckomöte in the förening's agenda Doc: items under their agenda item, tasks by role, info table, avslutat; human text untouched", async () => {
    const human = linesOf(fixtureDoc()).filter((l) => l !== "");
    const sim = FormatSim.start({ id: "m-vecko", doc: fixtureDoc(), profile: VECKOMOTE, script: { notes: VECKOMOTE_SCRIPT }, people: PEOPLE });
    expect(sim.meeting.agenda_roles).toEqual({ "ag-1": "procedural", "ag-2": "checkin", "ag-3": "followup", "ag-4": "topic", "ag-5": "topic", "ag-6": "other" });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Sommarfesten blir lördag den 14 juni. Anna bokar Kårallen till fredag." }]));
    await sim.tick(block([{ at: 50_000, speaker: 1, text: "Kassan är tolv tusen. Erik skickar kallelsen." }]), { attendees: "Maja Holm, Anna Berg, Erik Lund", window: CLOSED });
    await sim.tick(block([{ at: 95_000, speaker: 2, text: "Nästa gång kör vi på distans." }]), { attendees: "Maja Holm, Anna Berg, Erik Lund", window: CLOSED });
    await sim.tick(null, { final: true, attendees: "Maja Holm, Anna Berg, Erik Lund", window: CLOSED });

    expect(linesOf(sim.doc)).toEqual([
      "Mötesprotokoll:",
      "",
      "Datum",
      "2026-11-25",
      "Tid",
      "18:05–19:10",
      "Närvarande",
      "Maja Holm, Anna Berg, Erik Lund",
      "Sekreterare",
      "Elin Berglund",
      "",
      "Agenda:",
      "Godkänn dagordning",
      "Må-runda",
      "– Må-runda genomförd.",
      "Från förra veckan",
      "Kommande event",
      "Sommarfest på Kårallen",
      "Workshop om sponsring",
      "Beslut: Sommarfesten hålls lördag 14 juni på Kårallen.",
      "Kassör: Boka Kårallen (fredag).",
      "Ekonomi",
      "– Kassan är 12 000 kr.",
      "Övrigt",
      "– Erik Lund: Skicka ut kallelsen till nästa möte.",
      "Vad ska vi göra till nästa gång?",
      "Ordförande: Boka lokal.",
      "Kassör: Boka Kårallen (fredag).",
      "Erik Lund: Skicka ut kallelsen till nästa möte.",
      "Anteckningar:",
      "Simon Says · avslutat 19:10",
      "Nästa möte hålls på distans.",
    ]);
    expect(isSubsequence(human, linesOf(sim.doc))).toBe(true);
    // The engine got the agenda and the people with roles on every call.
    expect(sim.inputs[0].agenda).toMatchObject({ formatName: "Veckomöte", groupBy: "role" });
    expect(sim.inputs[0].agenda?.people).toContainEqual({ name: "Anna Berg", role: "Kassör" });
    expect(sim.rows.find((r) => r.id === "n2")).toMatchObject({ kind: "task", anchor: "ag-4", owner_person_id: "p-1" });
    expect(sim.rows.find((r) => r.id === "n2-t")).toMatchObject({ anchor: "tasks", copy_of: "n2" });
  });

  it("Veckomöte without Må-runda (Anpassa format): a new Doc without the item, no Må-runda line, notes under Övriga punkter", async () => {
    const profile = { ...VECKOMOTE, fixedAgendaItems: VECKOMOTE.fixedAgendaItems.filter((i) => i.role !== "checkin") };
    const sim = FormatSim.skeleton({
      id: "m-nocheck",
      profile,
      people: PEOPLE,
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "decision", anchor: "ag-3", text: "Vi köper en ny projektor" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-3", text: "Beställa projektorn", owner: "kassören" },
          ],
        ]),
      },
    });
    expect(Object.values(sim.meeting.agenda_roles ?? {})).not.toContain("checkin");
    expect(tick.checkinAnchor(sim.meeting)).toBeNull();
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Vi köper en projektor, kassören beställer." }]), { window: CLOSED });
    await sim.tick(null, { final: true, window: CLOSED });
    expect(linesOf(sim.doc)).toEqual([
      "Mötesprotokoll",
      "",
      "Datum",
      "2026-11-25",
      "Tid",
      "18:05–19:10",
      "Närvarande",
      "",
      "Sekreterare",
      "",
      "",
      "Agenda",
      "Godkänn dagordning",
      "Från förra veckan",
      "Övriga punkter",
      // Under an item without sub-points our line carries the "– " prefix (Ruling R-A1).
      "– Beslut: Vi köper en ny projektor.",
      "– Kassör: Beställa projektorn.",
      "Övrigt",
      "Vad ska vi göra till nästa gång?",
      "Kassör: Beställa projektorn.",
      "Anteckningar",
      "Simon Says · avslutat 19:10",
    ]);
    expect(linesOf(sim.doc).some((l) => /må-runda/i.test(l))).toBe(false);
  });

  it("Styrelseprotokoll with the stadgar's required items: §1..§11, a decision under its §, the Justerare task above the signatures", async () => {
    offline.on = true;
    const stadgar = readFileSync("fixtures/stadgar/fiktiv-forening.txt", "utf8");
    const { client, calls } = scriptedClient({
      stadgar: () => ({ items: ["Mötets öppnande", "Fråga om mötets behöriga utlysande", "Val av justerare", "Ekonomisk rapport"] }),
    });
    const req = await extractRequiredItems({ kind: "doc", text: stadgar }, { orgId: "o", client });
    expect(req.ok).toBe(true);
    expect(calls[0].text).toContain("Fråga om mötets behöriga utlysande");
    const profile = { ...STYRELSEPROTOKOLL, requiredItems: req.ok ? req.items : [] };
    const sim = FormatSim.skeleton({
      id: "m-styr",
      profile,
      people: [...PEOPLE, { name: "Sara Ek", role: "Justerare" }],
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "decision", anchor: "ag-8", text: "Att godkänna föregående protokoll" },
            { op: "add", id: "x2", kind: "note", anchor: "ag-7", text: "Kassan är 4 300 kr" },
          ],
          [{ op: "add", id: "x3", kind: "task", anchor: "ag-10", text: "Justera protokollet inom två veckor", owner: "Sara Ek" }],
        ]),
      },
    });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Föregående protokoll godkänns. Kassan är 4 300." }]));
    await sim.tick(block([{ at: 60_000, speaker: 1, text: "Sara justerar inom två veckor." }]), { attendees: "Maja Holm, Sara Ek" });
    await sim.tick(null, { final: true, attendees: "Maja Holm, Sara Ek" });
    expect(linesOf(sim.doc)).toEqual([
      "Styrelseprotokoll",
      "",
      "Datum",
      "2026-11-25",
      "Tid",
      "18:05–19:10",
      "Plats",
      "",
      "Närvarande",
      "Maja Holm, Sara Ek",
      "",
      "Dagordning",
      "§1 Mötets öppnande",
      "§2 Val av mötesordförande",
      "§3 Val av mötessekreterare",
      "§4 Val av justerare",
      "§5 Godkännande av dagordning",
      "§6 Fråga om mötets behöriga utlysande",
      "§7 Ekonomisk rapport",
      // Under a §-heading item: a bullet of its own, no "– " prefix.
      "Kassan är 4 300 kr.",
      "§8 Föregående protokoll",
      "Beslut: Att godkänna föregående protokoll.",
      "§9 Övriga punkter",
      "§10 Övriga frågor",
      "Justerare: Justera protokollet inom två veckor.",
      "§11 Mötets avslutande",
      "Att göra",
      "Justerare: Justera protokollet inom två veckor.",
      "Mötesordförande: ____________________",
      "Mötessekreterare: ____________________",
      "Justerare: ____________________",
      "Simon Says · avslutat 19:10",
    ]);
  });

  it("Enkel (v1 layout): the four sections, owner by name, 'Avslutat' header", async () => {
    const sim = V1Sim.start({
      id: "m-enkel",
      people: PEOPLE,
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", section: "attendees", text: "Anna Berg, Erik Lund" },
            { op: "add", id: "x2", section: "decision", text: "Vi byter lokal i januari" },
            { op: "add", id: "x3", section: "action", text: "Ringa hyresvärden", owner: "Anna Berg", due: "måndag" },
            { op: "add", id: "x4", section: "now", text: "Budget för våren" },
          ],
        ]),
      },
    });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Vi byter lokal i januari. Anna ringer hyresvärden på måndag." }]));
    await sim.tick(null, { final: true });
    expect(ENKEL.tasksSection?.groupBy).toBe("person");
    expect(linesOf(sim.doc)).toEqual([
      "Avslutat 19:10",
      "Närvarande",
      "Anna Berg, Erik Lund",
      "Beslut",
      "✓ Vi byter lokal i januari",
      "Att göra",
      "☐ Anna Berg: Ringa hyresvärden (måndag)",
      "Pågår nu",
      "Budget för våren",
    ]);
  });

  it("a learned format (Lär Simon Says ert format): only structure reaches Claude; tasks grouped by person, its own sections", async () => {
    offline.on = true;
    // Fictional old minutes: the structure is learned, the content never leaves.
    const old: Doc = docOf([
      paraEl("Protokoll styrelsemöte", { style: "HEADING_1" }),
      paraEl("Punkter", { style: "HEADING_2" }),
      paraEl("Öppning", { level: 0, listId: "list-h" }),
      paraEl("Uppföljning", { level: 0, listId: "list-h" }),
      paraEl("Hemlig punkt om kassaskåpskoden 4711", { level: 1, listId: "list-h" }),
      paraEl("Övrigt", { level: 0, listId: "list-h" }),
      paraEl("Uppgifter", { style: "HEADING_2" }),
      paraEl("Anna Berg: köpa kaffe"),
    ]);
    const structure = docStructure(old);
    const learned = {
      kind: "learned",
      title: "Protokoll",
      infoTable: ["Datum", "Närvarande"],
      agendaHeading: "Punkter",
      fixedAgendaItems: [
        { key: "open", label: "Öppning", role: "procedural", position: null },
        { key: "follow", label: "Uppföljning", role: "followup", position: null },
        { key: "misc", label: "Övrigt", role: "other", position: "last" },
      ],
      numbering: "numbered",
      tasksSection: { label: "Uppgifter", groupBy: "person" },
      notesSection: null,
      decisionPrefix: "Beslut:",
      taskStyle: "role-first",
      tone: "full-sentences",
      signatures: null,
      requiredItems: [],
    };
    const { client, calls } = scriptedClient({ learn: () => ({ profile: learned, explanation: "Numrerade punkter.", quality_note: "Datum saknas ofta." }) });
    const res = await proposeFormat({ orgId: "o", docs: [{ isTemplate: false, structure }] }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0].text).not.toContain("4711");
    expect(calls[0].text).not.toContain("kaffe");
    expect(res.profile.kind).toBe("learned");

    const sim = FormatSim.skeleton({
      id: "m-learned",
      profile: res.profile,
      people: PEOPLE,
      script: { notes: notesTicks([[{ op: "add", id: "x1", kind: "task", anchor: "ag-3", text: "Köpa nya pärmar", owner: "kassören" }]]) },
    });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Kassören köper pärmar." }]));
    await sim.tick(null, { final: true });
    expect(linesOf(sim.doc)).toEqual([
      "Protokoll",
      "",
      "Datum",
      "2026-11-25",
      "Närvarande",
      "",
      "",
      "Punkter",
      "Öppning",
      "Uppföljning",
      "Övriga punkter",
      "– Anna Berg: Köpa nya pärmar.",
      "Övrigt",
      "Uppgifter",
      "Anna Berg: Köpa nya pärmar.",
      "Simon Says · avslutat 19:10",
    ]);
  });
});

// Parked findings from the final re-review: fictional agendas in docsim.
describe("feature: formats (parked fixes)", () => {
  const BUL = "list-b";
  type El = docs_v1.Schema$StructuralElement;
  /** An agenda Doc: H1 title, H2 "Agenda", `items`, H2 "Anteckningar"; list-b is a bulleted list. */
  const agendaDoc = (items: El[]): Doc => {
    const doc = docOf([paraEl("Veckomöte", { style: "HEADING_1" }), paraEl("Agenda", { style: "HEADING_2" }), ...items, paraEl("Anteckningar", { style: "HEADING_2" })]);
    doc.tabs![0].documentTab!.lists![BUL] = { listProperties: { nestingLevels: [{ glyphSymbol: "●" }, { glyphSymbol: "○" }] } };
    return doc;
  };
  const num = (text: string) => paraEl(text, { level: 0 });
  const bul = (text: string, level = 0) => paraEl(text, { level, listId: BUL });
  const agKeys = (sim: InstanceType<typeof FormatSim>) => Object.keys(sim.meeting.section_ranges ?? {}).filter((k) => k.startsWith("ag-")).sort();
  const para = (sim: InstanceType<typeof FormatSim>, text: string) => sim.tab().paragraphs.find((p) => p.text === `${text}\n`)!;
  const range = (startIndex: number, endIndex: number) => ({ tabId: TAB, startIndex, endIndex });
  const body = (doc: Doc) => doc.tabs![0].documentTab!.body!.content!;
  const elOf = (doc: Doc, text: string) => body(doc).find((el) => el.paragraph?.elements?.[0]?.textRun?.content === `${text}\n`)!;

  it("N6: a mixed agenda (1–3 numbered, then 4–6 bulleted at the same level) gives six items, notes under item 5", async () => {
    const doc = agendaDoc([num("Godkänn dagordning"), num("Må-runda"), num("Från förra veckan"), bul("Kommande event"), bul("Ekonomi"), bul("Övrigt")]);
    const sim = FormatSim.start({
      id: "m-n6",
      doc,
      profile: VECKOMOTE,
      people: PEOPLE,
      script: { notes: notesTicks([[{ op: "add", id: "x1", kind: "note", anchor: "ag-5", text: "Kassan är 12 000 kr" }]]) },
    });
    expect(agKeys(sim)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6"]);
    expect(sim.meeting.agenda_roles).toMatchObject({ "ag-3": "followup", "ag-6": "other" });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Kassan är tolv tusen." }]));
    const lines = linesOf(sim.doc);
    expect(lines.slice(lines.indexOf("Ekonomi"), lines.indexOf("Övrigt"))).toEqual(["Ekonomi", "– Kassan är 12 000 kr."]);
    expect(agKeys(sim)).toHaveLength(6);
  });

  it("N6: a bulleted list nested deeper, or under an item's own text, stays that item's sub-points", () => {
    const deeper = agendaDoc([num("Godkänn dagordning"), num("Må-runda"), num("Ekonomi"), bul("Fakturan från hallen", 1), bul("Medlemsavgifter", 1)]);
    const underText = agendaDoc([num("Godkänn dagordning"), num("Må-runda"), num("Ekonomi"), paraEl("Vi går igenom:"), bul("Fakturan från hallen"), bul("Medlemsavgifter")]);
    for (const [id, doc, text] of [
      ["m-n6a", deeper, "Fakturan från hallen\nMedlemsavgifter"],
      ["m-n6b", underText, "Vi går igenom:\nFakturan från hallen\nMedlemsavgifter"],
    ] as const) {
      const sim = FormatSim.start({ id, doc, profile: VECKOMOTE, script: {} });
      expect(agKeys(sim)).toEqual(["ag-1", "ag-2", "ag-3"]);
      const tab = sim.tab();
      expect(scanAgenda(tab, VECKOMOTE, { anchors: anchoredStarts(tab, sim.meeting.section_ranges ?? {}, id) }).items.map((i) => [i.label, i.humanText])).toEqual([
        ["Godkänn dagordning", ""],
        ["Må-runda", ""],
        ["Ekonomi", text],
      ]);
    }
  });

  it("N2: one numbered item a human took the bullet off does not flip the meeting into bold mode", async () => {
    const doc = agendaDoc([num("Godkänn dagordning"), num("Må-runda"), num("Kommande event"), num("Ekonomi"), num("Övrigt")]);
    const sim = FormatSim.start({
      id: "m-n2a",
      doc,
      profile: VECKOMOTE,
      people: PEOPLE,
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "note", anchor: "ag-3", text: "Sommarfesten är bokad" },
            { op: "add", id: "x2", kind: "note", anchor: "ag-4", text: "Fakturan är betald" },
          ],
        ]),
      },
    });
    const ev = para(sim, "Kommande event");
    sim.human([{ deleteParagraphBullets: { range: range(ev.start, ev.end) } }]);
    // Under Ekonomi a fully bold note line and a typed "2. …" line (their bullets removed).
    const ek = para(sim, "Ekonomi");
    sim.human([{ insertText: { text: "\nKassan stämmer\n2. Budgeten är klar", location: { tabId: TAB, index: ek.end - 1 } } }]);
    const kassan = para(sim, "Kassan stämmer");
    sim.human([{ deleteParagraphBullets: { range: range(kassan.start, para(sim, "2. Budgeten är klar").end) } }]);
    elOf(sim.doc, "Kassan stämmer").paragraph!.elements![0].textRun!.textStyle = { bold: true };
    expect(sim.tab().paragraphs.find((p) => p.text === "Kassan stämmer\n")?.bold).toBe(true);

    await sim.tick(block([{ at: 1000, speaker: 0, text: "Sommarfesten är bokad och fakturan betald." }]));
    expect(agKeys(sim)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5"]);
    const lines = linesOf(sim.doc);
    expect(lines.slice(lines.indexOf("Kommande event"), lines.indexOf("Övrigt"))).toEqual([
      "Kommande event",
      "– Sommarfesten är bokad.",
      "Ekonomi",
      "Kassan stämmer",
      "2. Budgeten är klar",
      "– Fakturan är betald.",
    ]);
  });

  it("N2: in a bold agenda a human's numbered list under an item is its sub-points, not new items", async () => {
    const b = (text: string) => paraEl(text, { bold: true });
    const doc = agendaDoc([b("Godkänn dagordning"), b("Ekonomi"), b("Övrigt")]);
    const sim = FormatSim.start({
      id: "m-n2b",
      doc,
      profile: VECKOMOTE,
      people: PEOPLE,
      script: { notes: notesTicks([[{ op: "add", id: "x1", kind: "note", anchor: "ag-2", text: "Fakturan är betald" }]]) },
    });
    expect(agKeys(sim)).toEqual(["ag-1", "ag-2", "ag-3"]);
    const ek = para(sim, "Ekonomi");
    sim.human([
      { insertText: { text: "\nFakturan från hallen\nMedlemsavgifter", location: { tabId: TAB, index: ek.end - 1 } } },
      { createParagraphBullets: { range: range(ek.end, ek.end + "Fakturan från hallen\nMedlemsavgifter".length), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
    ]);
    expect(para(sim, "Medlemsavgifter").bullet).toBeTruthy();
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Fakturan är betald." }]));
    expect(agKeys(sim)).toEqual(["ag-1", "ag-2", "ag-3"]);
    const lines = linesOf(sim.doc);
    expect(lines.slice(lines.indexOf("Ekonomi"), lines.indexOf("Övrigt"))).toEqual(["Ekonomi", "Fakturan från hallen", "Medlemsavgifter", "Fakturan är betald."]);
  });

});

describe.skipIf(!hasLocalSupabase)("feature: formats (runTick on the local stack)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    starter = await createTestUser("suite-formats");
    const r = await createOrg(starter.db, "Suiteklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    profileId = await ensureStandardRow(orgId, "veckomote");
    const { error } = await adminClient()
      .from("people")
      .insert(PEOPLE.map((p) => ({ org_id: orgId, name: p.name, role: p.role })));
    if (error) throw new Error(error.message);
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  it("Veckomöte end to end through runTick: placement, tasks by role with person ids, Tid and avslutat", async () => {
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId });
    const { client, calls } = scriptedClient({ notes: VECKOMOTE_SCRIPT });
    const f = db.docsimDeps(doc, client);
    await db.say(id, sessionId, "speaker_0", "Sommarfesten blir lördag den 14 juni. Anna bokar Kårallen till fredag.", 1000);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    await db.say(id, sessionId, "speaker_1", "Kassan är tolv tusen. Erik skickar kallelsen.", 50_000);
    await db.backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    await db.say(id, sessionId, "speaker_2", "Nästa gång kör vi på distans.", 95_000);
    await db.backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    await adminClient().from("meetings").update({ status: "ending", ended_at: FMT_ENDED.toISOString() }).eq("id", id);
    expect(await tick.runTick(id, { final: true }, f.deps)).toBe("ok");
    expect(calls.filter((c) => c.kind === "notes")).toHaveLength(4);

    const lines = linesOf(doc);
    expect(lines.slice(lines.indexOf("Kommande event"), lines.indexOf("Ekonomi"))).toEqual([
      "Kommande event",
      "Sommarfest på Kårallen",
      "Workshop om sponsring",
      "Beslut: Sommarfesten hålls lördag 14 juni på Kårallen.",
      "Kassör: Boka Kårallen (fredag).",
    ]);
    expect(lines.slice(lines.indexOf("Vad ska vi göra till nästa gång?"), lines.indexOf("Anteckningar:"))).toEqual([
      "Vad ska vi göra till nästa gång?",
      "Ordförande: Boka lokal.",
      "Kassör: Boka Kårallen (fredag).",
      "Erik Lund: Skicka ut kallelsen till nästa möte.",
    ]);
    expect(lines[lines.indexOf("Tid") + 1]).toBe("18:05–19:10");
    expect(lines).toContain("Simon Says · avslutat 19:10");
    expect(lines.at(-1)).toBe("Nästa möte hålls på distans.");
    const rows = await db.noteRows(id);
    const { data: anna } = await adminClient().from("people").select("id").eq("org_id", orgId).eq("name", "Anna Berg").single();
    expect(rows.find((r) => r.id === "n2")).toMatchObject({ kind: "task", anchor: "ag-4", owner_person_id: anna!.id });
    await db.finish(id);
  });
});
