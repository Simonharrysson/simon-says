import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { EnvOverride } from "@/test/suite-db";

// Feature 2: transcription style, how people speak and refer to each other. Owners named by full
// name, first name, role ("kassören", "ordföranden"), "jag", someone not in the people list, in
// English; filler and false starts. Free tier: owner resolution and the rendered owner label for
// each case, and the Transkript tab keeping what was said verbatim (speaker names, nothing masked).
// The paid fixture fixtures/notes/owner-styles has Claude assign tasks in all these ways.

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
const { resolveOwner, ownerLabel } = await import("@/lib/people/roles");
const { formatLine } = await import("@/lib/docs/transcript");
const { FormatSim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { fixtureDoc, linesOf } = await import("@/test/formatdoc");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const db = await import("@/test/suite-db");

const PEOPLE = [
  { id: "p-anna", name: "Anna Berg", role: "Kassör" },
  { id: "p-erik", name: "Erik Lund", role: null },
  { id: "p-maja", name: "Maja Holm", role: "Ordförande" },
  { id: "p-sam", name: "Sam Carter", role: "PR-ansvarig" },
  { id: "p-elin", name: "Elin Sjöberg", role: "Sekreterare" },
];
const label = (owner: string, people = PEOPLE) => ownerLabel(resolveOwner(owner, people), owner, "role");

describe("feature: transcription (how people name each other)", () => {
  it("resolves full names, first names and Swedish roles (any case, definite form) to the förening's person", () => {
    const cases: [string, string | null][] = [
      ["Anna Berg", "p-anna"],
      ["anna berg", "p-anna"],
      ["  Anna   Berg ", "p-anna"],
      ["Anna", "p-anna"],
      ["kassören", "p-anna"],
      ["Kassören", "p-anna"],
      ["kassör", "p-anna"],
      ["ordföranden", "p-maja"],
      ["Ordförande", "p-maja"],
      ["sekreteraren", "p-elin"],
      ["Erik", "p-erik"],
      ["PR-ansvarig", "p-sam"],
    ];
    for (const [text, id] of cases) expect([text, resolveOwner(text, PEOPLE)?.id ?? null]).toEqual([text, id]);
  });

  it("owner labels: the role when the person has one, else the full name", () => {
    expect(["Anna", "kassören", "ordföranden", "Erik", "Sam Carter"].map((o) => label(o))).toEqual(["Kassör", "Kassör", "Ordförande", "Erik Lund", "PR-ansvarig"]);
  });

  it("someone not in the people list, an English role, an ambiguous first name: the owner text as said, no person", () => {
    expect(resolveOwner("Lisa", PEOPLE)).toBeNull();
    expect(label("Lisa")).toBe("Lisa");
    // English: the roles are Swedish labels; Claude is expected to write the person's name.
    expect(resolveOwner("the treasurer", PEOPLE)).toBeNull();
    expect(label("the treasurer")).toBe("the treasurer");
    const twoAnnas = [...PEOPLE, { id: "p-anna2", name: "Anna Lund", role: null }];
    expect(resolveOwner("Anna", twoAnnas)).toBeNull();
    expect(label("Anna", twoAnnas)).toBe("Anna");
    expect(resolveOwner("Anna Lund", twoAnnas)?.id).toBe("p-anna2");
  });

  it('"jag" is not resolved by the code: the engine gets speakerNames so Claude writes the speaker\'s name (pinned)', () => {
    expect(resolveOwner("jag", PEOPLE)).toBeNull();
    expect(label("jag")).toBe("jag");
  });

  // BUG (lib/people/roles.ts stems, line 37): the definite form of an "-ansvarig" role ends in
  // "-e" ("PR-ansvarige", "eventansvarige"), which no suffix rule strips, so a task Claude gives
  // "PR-ansvarige" renders as "PR-ansvarige: …" with no person id instead of "PR-ansvarig: …".
  it.fails("BUG: the definite form of an -ansvarig role ('PR-ansvarige') resolves to its person", () => {
    expect(resolveOwner("PR-ansvarige", PEOPLE)?.id).toBe("p-sam");
  });

  it("each way of naming an owner, rendered in the agenda Doc and stored with its person id", async () => {
    const sim = FormatSim.start({
      id: "m-owners",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      speakerNames: { "S1-speaker_0": "Maja Holm", "S1-speaker_1": "Anna Berg", "S1-speaker_2": "Sam Carter" },
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-4", text: "Ringa kommunen", owner: "Erik" },
            { op: "add", id: "x3", kind: "task", anchor: "ag-5", text: "Betala hyran", owner: "kassören" },
            { op: "add", id: "x4", kind: "task", anchor: "ag-5", text: "Mejla revisorn", owner: "ordföranden" },
            { op: "add", id: "x5", kind: "task", anchor: "ag-6", text: "Låna ut släpvagnen", owner: "Lisa" },
            { op: "add", id: "x6", kind: "task", anchor: "ag-6", text: "Post the event on Instagram", owner: "Sam Carter" },
          ],
        ]),
      },
    });
    await sim.tick(
      block([
        { at: 1000, speaker: 0, text: "Eh, alltså, Anna Berg bokar Kårallen. Och Erik, du ringer kommunen?" },
        { at: 9000, speaker: 1, text: "Jag– jag betalar hyran, det är ju kassörens grej. Och ordföranden mejlar revisorn." },
        { at: 20_000, speaker: 0, text: "Lisa, min granne, lånar ut släpvagnen." },
        { at: 30_000, speaker: 2, text: "I'll post the event on Instagram." },
      ]),
    );
    // The engine got the speaker names (so "jag" can become a name) and the people with roles.
    expect(sim.inputs[0].speakerNames["S1-speaker_1"]).toBe("Anna Berg");
    expect(sim.inputs[0].agenda?.people).toContainEqual({ name: "Sam Carter", role: "PR-ansvarig" });
    const lines = linesOf(sim.doc);
    expect(lines.slice(lines.indexOf("Vad ska vi göra till nästa gång?") + 1, lines.indexOf("Anteckningar:"))).toEqual([
      "Ordförande: Boka lokal.",
      "Ordförande: Mejla revisorn.",
      "Kassör: Boka Kårallen.",
      "Kassör: Betala hyran.",
      "Erik Lund: Ringa kommunen.",
      "Lisa: Låna ut släpvagnen.",
      "PR-ansvarig: Post the event on Instagram.",
    ]);
    expect(Object.fromEntries(sim.rows.filter((r) => /^n\d+$/.test(r.id)).map((r) => [r.owner, r.owner_person_id ?? null]))).toEqual({
      "Anna Berg": "p-anna",
      Erik: "p-erik",
      kassören: "p-anna",
      ordföranden: "p-maja",
      Lisa: null,
      "Sam Carter": "p-sam",
    });
  });

  it("Transkript tab: what was said verbatim (filler, false starts, English), named speakers, an unnamed voice by its label, nothing masked", () => {
    const sessions = [{ id: "sess-a", started_at: "2026-11-25T17:05:00Z" }];
    const seg = (i: number, speaker: string, text: string, startMs: number) => ({
      el_session_id: "sess-a",
      segment_index: i,
      run_index: 0,
      speaker,
      text,
      start_ms: startMs,
      tick_no: 1,
      transcript_written_at: null,
    });
    const segments = [
      seg(0, "speaker_0", "Eh, alltså… öh, vi kör väl igång?", 1000),
      seg(1, "speaker_1", "Jag– jag mår bra, lite trött bara.", 4000),
      seg(2, "speaker_2", "Sorry, I'll switch to English: I'll take the posters.", 9000),
      seg(3, "speaker_3", "Kassören, eller nej vänta, Erik tar det.", 12_000),
    ];
    const speakers = [
      { el_session_id: "sess-a", speaker_label: "speaker_0", display_name: "Maja Holm", person_id: "p-maja" },
      { el_session_id: "sess-a", speaker_label: "speaker_1", display_name: "Anna Berg", person_id: "p-anna" },
      { el_session_id: "sess-a", speaker_label: "speaker_2", display_name: "Sam Carter", person_id: "p-sam" },
    ];
    // Even with a Må-runda window over the second line: the Transkript is never masked (only Claude's blocks are).
    const lines = tick.transcriptLines(segments, sessions, speakers);
    expect(lines.map(formatLine)).toEqual([
      "Maja Holm 00:00:01: Eh, alltså… öh, vi kör väl igång?",
      "Anna Berg 00:00:04: Jag– jag mår bra, lite trött bara.",
      "Sam Carter 00:00:09: Sorry, I'll switch to English: I'll take the posters.",
      "S1-speaker_3 00:00:12: Kassören, eller nej vänta, Erik tar det.",
    ]);
    const masked = tick.buildTranscript(segments, sessions, speakers, { startMs: 4000, endMs: 5000, closed: true, failures: 0 });
    expect(masked.blocks[0]).not.toContain("trött");
    expect(masked.blocks[0]).toContain("[00:00:01] S1-speaker_0: Eh, alltså… öh, vi kör väl igång?");
    // Claude's blocks only: a voice heard only inside the window is not named to Claude either.
    expect(masked.speakerNames).toEqual({ "S1-speaker_0": "Maja Holm", "S1-speaker_2": "Sam Carter" });
  });
});

describe("feature: transcription (the paid fixture owner-styles, replayed for $0)", () => {
  it("a perfect scripted answer scores every bar: recall, placement, roles (one owner per naming style)", async () => {
    const { join } = await import("node:path");
    const { loadExpected, loadLines, runReplay, score, scorePasses, ticksOf } = await import("@/scripts/lib/notes-run");
    const dir = join("fixtures", "notes");
    const expected = loadExpected(join(dir, "owner-styles.expected.json"));
    const lines = loadLines(join(dir, "owner-styles.jsonl"));
    // Owners as Claude should write them: the person's name (also for "jag" and roles), else as said.
    const owners: Record<string, string> = { A3: "Per Olsson" };
    const ops = [
      ...(expected.decisions ?? []).map((d, i) => ({ op: "add", id: `d${i}`, kind: "decision", anchor: d.anchor, text: d.text })),
      ...(expected.action_items ?? []).map((a, i) => ({ op: "add", id: `a${i}`, kind: "task", anchor: a.anchor ?? "notes", text: a.text, owner: a.owner ?? owners[a.key], due: a.due })),
    ];
    const { client, calls } = scriptedClient({ notes: (_c, n) => ({ ops: n === 0 ? ops : [] }) });
    const r = await runReplay({ lines, expected, tickMs: 45_000, agenda: true, client });
    expect(calls.every((c) => c.kind === "notes")).toBe(true); // no Må-runda item: no detector call
    expect(calls[0].text).toContain("Leo Martin");
    const s = score(r.items, expected, ticksOf(r));
    expect(s.recall.filter((l) => !l.startsWith("FOUND"))).toEqual([]);
    expect([s.found, s.total, s.placement, s.roles]).toEqual([9, 9, { ok: 7, total: 7 }, { ok: 6, total: 6 }]);
    expect(scorePasses(s)).toBe(true);
  });
});

describe.skipIf(!hasLocalSupabase)("feature: transcription (runTick on the local stack)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    starter = await createTestUser("suite-transcription");
    const r = await createOrg(starter.db, "Talstilsklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    profileId = await ensureStandardRow(orgId, "veckomote");
    const { data, error } = await adminClient()
      .from("people")
      .insert(PEOPLE.map((p) => ({ org_id: orgId, name: p.name, role: p.role })))
      .select("id, name");
    if (error) throw new Error(error.message);
    for (const p of data ?? []) ids.set(p.name as string, p.id as string);
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  it("owners by name, first name, role and 'not in the list' get the right person ids; the Transkript lines are verbatim with names", async () => {
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId, transcriptTab: true });
    await adminClient().from("speaker_map").insert([
      { meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_0", display_name: "Maja Holm", person_id: ids.get("Maja Holm") },
      { meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_1", display_name: "Anna Berg", person_id: ids.get("Anna Berg") },
    ]);
    await db.say(id, sessionId, "speaker_0", "Eh, alltså, Erik ringer kommunen och kassören betalar hyran.", 1000);
    await db.say(id, sessionId, "speaker_1", "Jag– jag mejlar revisorn. Lisa lånar ut släpvagnen.", 6000);
    await db.say(id, sessionId, "speaker_2", "I'll do the posters.", 9000);
    const { client, calls } = scriptedClient({
      notes: notesTicks([
        [
          { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Ringa kommunen", owner: "Erik" },
          { op: "add", id: "x2", kind: "task", anchor: "ag-5", text: "Betala hyran", owner: "kassören" },
          { op: "add", id: "x3", kind: "task", anchor: "ag-5", text: "Mejla revisorn", owner: "Anna Berg" },
          { op: "add", id: "x4", kind: "task", anchor: "ag-6", text: "Låna ut släpvagnen", owner: "Lisa" },
        ],
      ]),
    });
    const f = db.docsimDeps(doc, client);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    // Claude saw the raw labels in the blocks and the names beside them.
    expect(calls[0].text).toContain("S1-speaker_1: Jag– jag mejlar revisorn.");
    expect(calls[0].text).toContain("Anna Berg");
    const rows = await db.noteRows(id);
    expect(Object.fromEntries(rows.filter((r) => /^n\d+$/.test(r.id)).map((r) => [r.owner, r.owner_person_id]))).toEqual({
      Erik: ids.get("Erik Lund"),
      kassören: ids.get("Anna Berg"),
      "Anna Berg": ids.get("Anna Berg"),
      Lisa: null,
    });
    expect(linesOf(doc)).toContain("Lisa: Låna ut släpvagnen.");
    expect(f.appended.flat().map(formatLine)).toEqual([
      "Maja Holm 00:00:01: Eh, alltså, Erik ringer kommunen och kassören betalar hyran.",
      "Anna Berg 00:00:06: Jag– jag mejlar revisorn. Lisa lånar ut släpvagnen.",
      "S1-speaker_2 00:00:09: I'll do the posters.",
    ]);
  });
});
