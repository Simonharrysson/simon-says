import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { EnvOverride } from "@/test/suite-db";

// Feature 5: safety rails. Human edits win (an edited line locks, a deleted line is never
// re-added, human text under an item is never touched); a revision conflict retries; the kill
// switch and the daily dollar cap stop Claude; privacy: no Doc or transcript text in events or
// logs, and format learning sends only structure.

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
const { FormatSim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { fixtureDoc, linesOf, docText, applyDoc } = await import("@/test/formatdoc");
const { TAB } = await import("@/test/docsim");
const { itemSpan } = await import("@/lib/docs/notes");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { updateNotes } = await import("@/lib/notes/engine");
const { proposeFormat } = await import("@/lib/formats/learn");
const { docStructure } = await import("@/lib/formats/structure");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const db = await import("@/test/suite-db");

type Doc = docs_v1.Schema$Document;
const PEOPLE = [{ name: "Anna Berg", role: "Kassör" }, { name: "Erik Lund" }];

/** A human types `text` just before the final "." of our line (inside its range: the row locks). */
function humanEditsOurLine(doc: Doc, rangeName: string, text: string) {
  const span = itemSpan(parseNotesTab(doc, TAB), rangeName)!;
  applyDoc(doc, [{ insertText: { text, location: { tabId: TAB, index: span.paraEnd - 2 } } }]);
}
/** A human deletes our whole line (its paragraph). */
function humanDeletesOurLine(doc: Doc, rangeName: string) {
  const span = itemSpan(parseNotesTab(doc, TAB), rangeName)!;
  applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: span.paraStart, endIndex: span.paraEnd } } }]);
}

describe("feature: safety (safety rails)", () => {
  afterEach(() => {
    offline.on = false;
    vi.restoreAllMocks();
  });

  it("human edits win: an edited line locks and keeps the human's text, a deleted line is never re-added, human sub-points stay", async () => {
    const sim = FormatSim.start({
      id: "m-human",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "decision", anchor: "ag-5", text: "Kassan räcker till våren" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
          ],
          // Claude tries to rewrite the line the human edited and to re-add the deleted task.
          [
            { op: "change", id: "n1", text: "Kassan räcker hela året" },
            { op: "add", id: "x3", kind: "note", anchor: "ag-5", text: "Revisorn är nöjd" },
          ],
        ]),
      },
    });
    await sim.tick(block([{ at: 1000, speaker: 0, text: "Kassan räcker. Anna bokar Kårallen." }]));
    expect(linesOf(sim.doc)).toContain("– Beslut: Kassan räcker till våren.");
    // A human sub-point under Kommande event, an edit of our decision, our task's primary deleted.
    const sommar = parseNotesTab(sim.doc, TAB).paragraphs.find((p) => p.text === "Sommarfest på Kårallen\n")!;
    applyDoc(sim.doc, [{ insertText: { text: " (med grillning)", location: { tabId: TAB, index: sommar.end - 1 } } }]);
    humanEditsOurLine(sim.doc, "ss-m-human-n1", " men inte mer");
    humanDeletesOurLine(sim.doc, "ss-m-human-n2");

    await sim.tick(block([{ at: 50_000, speaker: 1, text: "Kassan räcker hela året. Revisorn är nöjd." }]), { allowDropped: true });
    // The engine was told: n1 is locked (human text), so its rewrite was refused. n2's primary is
    // gone, but its tasks copy is still ours: Claude edits the copy under n2's id (R-A6).
    expect(sim.inputs[1].locked.map((i) => i.id)).toEqual(["n1"]);
    expect(sim.inputs[1].deletedIds).toEqual([]);
    expect(sim.inputs[1].items.find((i) => i.id === "n2")).toMatchObject({ anchor: "ag-4", text: "Boka Kårallen" });
    expect(sim.results[1].dropped).toBe(1);
    await sim.tick(null, { final: true });
    const lines = linesOf(sim.doc);
    expect(lines).toContain("– Beslut: Kassan räcker till våren men inte mer.");
    expect(lines.some((l) => l.includes("hela året"))).toBe(false);
    expect(lines).toContain("Sommarfest på Kårallen (med grillning)");
    expect(lines).toContain("– Revisorn är nöjd.");
    // The deleted primary never comes back under Kommande event; its tasks copy is ours and stays.
    expect(lines.slice(lines.indexOf("Kommande event"), lines.indexOf("Ekonomi"))).toEqual(["Kommande event", "Sommarfest på Kårallen (med grillning)", "Workshop om sponsring"]);
    expect(sim.rows.find((r) => r.id === "n1")).toMatchObject({ locked: true });
    expect(sim.rows.find((r) => r.id === "n2")).toMatchObject({ deleted_by_human: true });
  });

  it("privacy: the engine's logs never quote the meeting (a malformed answer, a refusal)", async () => {
    const logged: string[] = [];
    for (const k of ["log", "warn", "error", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    const secret = "Kassaskåpskoden är 4711";
    const { client } = scriptedClient({ notes: () => `Här är anteckningarna: ${secret}` });
    const out = await updateNotes(
      {
        orgName: "Kodklubben",
        transcriptBlocks: [`[00:00:01] S1-speaker_0: ${secret}`],
        speakerNames: {},
        notesTabText: `Ekonomi\n${secret}`,
        items: [],
        locked: [],
        deletedIds: [],
        final: false,
      },
      { client },
    );
    expect(out.failure).toBe("malformed");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("4711");
  });

  it("privacy: format learning sends only the Doc's structure (no line under an item, no table value)", async () => {
    offline.on = true;
    const structure = docStructure(fixtureDoc());
    const { client, calls } = scriptedClient({ learn: () => ({ profile: { ...VECKOMOTE, fixedAgendaItems: VECKOMOTE.fixedAgendaItems.map((i) => ({ ...i, position: i.position ?? null })) }, explanation: "x", quality_note: "y" }) });
    expect((await proposeFormat({ orgId: "o", docs: [{ isTemplate: true, structure }] }, { client })).ok).toBe(true);
    const sent = JSON.stringify(calls[0].body);
    for (const content of ["Sommarfest på Kårallen", "Workshop om sponsring", "Elin Berglund", "Boka lokal"]) expect(sent).not.toContain(content);
    expect(sent).toContain("Från förra veckan"); // agenda item labels are structure
  });
});

describe.skipIf(!hasLocalSupabase)("feature: safety (runTick on the local stack)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    starter = await createTestUser("suite-safety");
    const r = await createOrg(starter.db, "Skyddsklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    profileId = await ensureStandardRow(orgId, "veckomote");
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });
  afterEach(() => vi.restoreAllMocks());

  const ONE_TASK = notesTicks([[{ op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" }]]);

  it("kill switch and the daily dollar cap: no Claude call, the Doc still gets its status line", async () => {
    for (const cap of [{ KILL_SWITCH: true }, { GLOBAL_DAILY_USD: 0 }]) {
      Object.assign(envOverride, cap);
      const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId });
      await db.say(id, sessionId, "speaker_0", "Anna bokar Kårallen.", 1000);
      const { client, calls } = scriptedClient({ notes: ONE_TASK });
      const f = db.docsimDeps(doc, client);
      expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
      expect(calls).toEqual([]);
      expect(linesOf(doc)).toContain("Simon Says antecknar live · uppdaterad 18:31");
      expect(linesOf(doc).some((l) => l.includes("Boka Kårallen"))).toBe(false);
      for (const k of Object.keys(cap)) delete envOverride[k as keyof EnvOverride];
      envOverride.GLOBAL_DAILY_USD = 1_000_000;
    }
  });

  it("a human typing between our read and our write: the guarded write conflicts, re-reads and retries; both texts end up in the Doc", async () => {
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId });
    await db.say(id, sessionId, "speaker_0", "Anna bokar Kårallen.", 1000);
    const { client } = scriptedClient({ notes: ONE_TASK });
    const f = db.docsimDeps(doc, client, {
      beforeRender: (attempt) => {
        if (attempt > 0) return;
        const ekonomi = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Ekonomi\n")!;
        applyDoc(doc, [{ insertText: { text: " och budget", location: { tabId: TAB, index: ekonomi.end - 1 } } }]);
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.renders()).toBe(2);
    expect(linesOf(doc)).toContain("Ekonomi och budget");
    // Skyddsklubben has no people rows: the owner is shown as said.
    expect(linesOf(doc).filter((l) => l === "Anna Berg: Boka Kårallen.")).toHaveLength(2);
    expect(await db.events(id, "tick_conflict")).toEqual([]);
  });

  it("a Doc that keeps changing: 1 + 4 attempts, then a tick_conflict event and nothing of ours written", async () => {
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId });
    await db.say(id, sessionId, "speaker_0", "Anna bokar Kårallen.", 1000);
    const { client } = scriptedClient({ notes: ONE_TASK });
    const f = db.docsimDeps(doc, client, {
      beforeRender: () => {
        const ovrigt = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text.startsWith("Övrigt"))!;
        applyDoc(doc, [{ insertText: { text: ".", location: { tabId: TAB, index: ovrigt.end - 1 } } }]);
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("conflict");
    expect(f.renders()).toBe(5);
    expect(await db.events(id, "tick_conflict")).toEqual([{ kind: "tick_conflict", detail: expect.objectContaining({ attempts: 5 }) }]);
    expect(docText(doc)).not.toContain("Boka Kårallen");
    expect(linesOf(doc)).toContain("Övrigt.....");
  });

  it("privacy: events and logs of a whole meeting hold no transcript or Doc text", async () => {
    const logged: string[] = [];
    for (const k of ["log", "warn", "error", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    const { id, sessionId, doc } = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId, status: "live" });
    await db.say(id, sessionId, "speaker_0", "Hemligt: kassaskåpskoden är 4711.", 1000);
    const { client } = scriptedClient({
      notes: notesTicks([[{ op: "add", id: "x1", kind: "note", anchor: "ag-5", text: "Kassaskåpskoden byts till 4712" }], [{ op: "change", id: "nope", text: "x" }]]),
    });
    const f = db.docsimDeps(doc, client);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    await db.say(id, sessionId, "speaker_0", "Och koden till förrådet är 9090.", 50_000);
    await db.backdate(id);
    // The second answer's op is dropped (unknown id): a failed tick that logs.
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("failed");
    const all = JSON.stringify(await db.events(id));
    for (const secret of ["4711", "4712", "9090", "Kassaskåp", "Sommarfest", "Elin Berglund"]) {
      expect(all).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
    expect(all).toContain("tick_ok");
    expect(all).toContain("tick_failed");
  });
});
