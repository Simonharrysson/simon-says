import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { EnvOverride } from "@/test/suite-db";

// Feature: concrete tasks (docs/superpowers/specs/2026-11-26-concrete-tasks-design.md). A scripted
// Veckomöte in a förening that requires Vem, När and Klart när: missing fields show as visible
// placeholders, a field said later replaces its placeholder in place, a person's edit in the Doc
// wins, the Avsluta dialog's answers are written by the final pass (Claude can't undo them), and
// the summary and Från förra veckan carry deadline + klart när (overdue marked). Free scripted
// Claude only; the paid fixture fixtures/notes/concrete-tasks checks that done_when is extracted.

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

const tick = await import("@/lib/meetings/tick");
const { FormatSim, V1Sim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { fixtureDoc, linesOf } = await import("@/test/formatdoc");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { TAB } = await import("@/test/docsim");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { incompleteTasks, meetingTasks } = await import("@/lib/notes/tasks");
const { summaryContent } = await import("@/lib/summaries/content");
const { carriedItems } = await import("@/lib/agenda/followup");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const db = await import("@/test/suite-db");

const PEOPLE = [
  { name: "Anna Berg", role: "Kassör" },
  { name: "Erik Lund", role: null },
  { name: "Maja Holm", role: "Ordförande" },
];

/** A person types `text` over `placeholder` in the first line containing it (a human edit). */
function typeOver(sim: InstanceType<typeof FormatSim>, placeholder: string, text: string) {
  const para = parseNotesTab(sim.doc, TAB).paragraphs.find((p) => p.text.includes(placeholder))!;
  const at = para.start + para.text.indexOf(placeholder);
  sim.human([
    { deleteContentRange: { range: { tabId: TAB, startIndex: at, endIndex: at + placeholder.length } } },
    { insertText: { text, location: { tabId: TAB, index: at } } },
  ]);
}

const tasksBlock = (lines: string[]) => {
  const all = lines;
  const from = all.indexOf("Vad ska vi göra till nästa gång?");
  return all.slice(from + 1, all.indexOf("Anteckningar:"));
};

describe("feature: concrete tasks (Vem, När, Klart när)", () => {
  it("placeholders when missing, replaced in place when said later; a person's edit wins; Avsluta answers win over the final pass", async () => {
    const sim = FormatSim.start({
      id: "m-tasks",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-5", text: "Mejla sponsorerna", owner: "Erik" },
            { op: "add", id: "x3", kind: "task", anchor: "ag-6", text: "Köpa fika" },
          ],
          // Said later: Kårallen by Friday, done when the contract is signed.
          [{ op: "change", id: "n1", due: "fredag", done_when: "kontraktet är påskrivet" }],
          [],
          // The final pass rewrites what the Avsluta dialog fills in: the person's answer wins.
          [{ op: "change", id: "n3", owner: "Erik", done_when: "någon har köpt fika" }],
        ]),
      },
    });
    sim.taskMode = "require";

    await sim.tick(block([{ at: 1000, speaker: 0, text: "Anna bokar Kårallen. Erik mejlar sponsorerna. Någon köper fika." }]));
    expect(linesOf(sim.doc)).toContain("Kassör: Boka Kårallen (deadline?) – (klart när?).");
    expect(tasksBlock(linesOf(sim.doc))).toEqual([
      "Ordförande: Boka lokal.",
      "(vem?): Köpa fika (deadline?) – (klart när?).",
      "Kassör: Boka Kårallen (deadline?) – (klart när?).",
      "Erik Lund: Mejla sponsorerna (deadline?) – (klart när?).",
    ]);
    expect(incompleteTasks(sim.rows).map((t) => [t.id, t.missing])).toEqual([
      ["n1", ["due", "doneWhen"]],
      ["n2", ["due", "doneWhen"]],
      ["n3", ["owner", "due", "doneWhen"]],
    ]);

    await sim.tick(block([{ at: 30_000, speaker: 0, text: "Kårallen senast fredag, klart när kontraktet är påskrivet." }]));
    // In place: both the line under the agenda item and its tasks-section copy.
    expect(linesOf(sim.doc).filter((l) => l.includes("Boka Kårallen"))).toEqual([
      "Kassör: Boka Kårallen (fredag) – klart när: kontraktet är påskrivet.",
      "Kassör: Boka Kårallen (fredag) – klart när: kontraktet är påskrivet.",
    ]);
    expect(sim.rows.find((r) => r.id === "n1")).toMatchObject({ due: "fredag", done_when: "kontraktet är påskrivet", due_date: "2026-11-27" });

    // Erik types the deadline over the placeholder under Ekonomi: his line now, never rewritten.
    typeOver(sim, "(deadline?)", "måndag");
    await sim.tick(block([{ at: 60_000, speaker: 1, text: "Fika fixar Maja." }]));
    const erik = meetingTasks(sim.rows).find((t) => t.id === "n2")!;
    expect(erik).toMatchObject({ locked: true, missing: ["doneWhen"] });

    // Avsluta: Köpa fika completed in the dialog, Erik's left as it is.
    sim.taskAnswers = [{ id: "n3", owner: "Maja Holm", due: "tisdag", doneWhen: "fikat står på bordet" }];
    await sim.tick(null, { final: true });
    expect(tasksBlock(linesOf(sim.doc))).toContain("Ordförande: Köpa fika (tisdag) – klart när: fikat står på bordet.");
    expect(sim.rows.find((r) => r.id === "n3")).toMatchObject({ owner: "Maja Holm", due: "tisdag", done_when: "fikat står på bordet" });

    // The summary: deadline and klart när; what is still missing when required.
    const summary = summaryContent(sim.rows, { agendaRoles: sim.meeting.agenda_roles, today: "2026-11-26", requireFields: true });
    expect(summary.tasks.map((t) => [t.text, t.due, t.doneWhen ?? null, t.missing])).toEqual([
      ["Boka Kårallen", "fredag", "kontraktet är påskrivet", []],
      [expect.stringContaining("Mejla sponsorerna måndag"), null, null, ["doneWhen"]],
      ["Köpa fika", "tisdag", "fikat står på bordet", []],
    ]);
  });

  it("Från förra veckan next week: deadline and klart när carried, a passed deadline marked försenad", async () => {
    const prev = [
      {
        meeting_id: "m-prev",
        id: "n1",
        section: "action" as const,
        kind: "task" as const,
        text: "Boka Kårallen",
        owner: "Anna Berg",
        due: "fredag",
        due_date: "2026-11-21",
        done_when: "kontraktet är påskrivet",
        locked: false,
        deleted_by_human: false,
        last_rendered_text: null,
        range_name: null,
        position: 0,
      },
    ];
    const carried = carriedItems("m-prev", prev, "ag-3", [], "role");
    expect(carried[0]).toMatchObject({ due: "fredag", due_date: "2026-11-21", done_when: "kontraktet är påskrivet" });
    const sim = FormatSim.start({ id: "m-next", doc: fixtureDoc(), profile: VECKOMOTE, people: PEOPLE, script: { notes: notesTicks([]) }, carried });
    sim.taskMode = "require";
    expect(linesOf(sim.doc)).toContain("– Kassör: Boka Kårallen (fredag, försenad) – klart när: kontraktet är påskrivet.");
  });

  it("v1 layout (Enkel): the same placeholders on the ☐ line", async () => {
    const sim = V1Sim.start({
      id: "m-enkel-tasks",
      script: { notes: notesTicks([[{ op: "add", id: "x1", section: "action", text: "Ringa hyresvärden", owner: "Anna Berg" }]]) },
    });
    sim.taskMode = "require";
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Anna ringer hyresvärden." }]));
    expect(linesOf(sim.doc)).toContain("☐ Anna Berg: Ringa hyresvärden (deadline?) – (klart när?)");
  });

  it("suggest mode (setting off): no placeholders, exactly the lines before concrete tasks", async () => {
    const sim = V1Sim.start({
      id: "m-enkel-suggest",
      script: { notes: notesTicks([[{ op: "add", id: "x1", section: "action", text: "Ringa hyresvärden", owner: "Anna Berg" }]]) },
    });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Anna ringer hyresvärden." }]));
    expect(linesOf(sim.doc)).toContain("☐ Anna Berg: Ringa hyresvärden");
  });
});

describe.skipIf(!hasLocalSupabase)("feature: concrete tasks (runTick on the local stack)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    starter = await createTestUser("suite-tasks");
    const r = await createOrg(starter.db, "Uppgiftsklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    profileId = await ensureStandardRow(orgId, "veckomote");
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  it("a new förening requires the fields (default on): placeholders in the Doc; the stored Avsluta answers are written by the final pass", async () => {
    const { data: org } = await adminClient().from("orgs").select("require_task_fields").eq("id", orgId).single();
    expect(org?.require_task_fields).toBe(true);
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId });
    await db.say(id, sessionId, "speaker_0", "Erik bokar Kårallen.", 1000);
    const { client } = scriptedClient({
      notes: notesTicks([
        [{ op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Erik" }],
        // The final pass sets another deadline: the dialog's answer still wins.
        [{ op: "change", id: "n1", due: "snart" }],
      ]),
    });
    const f = db.docsimDeps(doc, client);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(linesOf(doc)).toContain("Erik: Boka Kårallen (deadline?) – (klart när?).");

    await adminClient()
      .from("meetings")
      .update({ status: "ending", ended_at: new Date().toISOString(), task_answers: [{ id: "n1", due: "fredag", doneWhen: "kontraktet är påskrivet" }] })
      .eq("id", id);
    await db.say(id, sessionId, "speaker_0", "Då avslutar vi.", 20_000);
    expect(await tick.runTick(id, { final: true }, f.deps)).toBe("ok");
    expect(linesOf(doc)).toContain("Erik: Boka Kårallen (fredag) – klart när: kontraktet är påskrivet.");
    const rows = await db.noteRows(id);
    expect(rows.find((r) => r.id === "n1")).toMatchObject({ due: "fredag", done_when: "kontraktet är påskrivet" });
    expect(rows.find((r) => r.id === "n1")?.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
