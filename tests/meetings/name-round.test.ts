import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { TranscriptLine } from "@/lib/docs/transcript";
import type { ExtractedName, NameSegment } from "@/lib/names/extract";
import type { UpdateNotesInput, UpdateNotesResult } from "@/lib/notes/engine";

type EnvOverride = { KILL_SWITCH?: boolean; GLOBAL_DAILY_HOURS?: number; GLOBAL_DAILY_USD?: number };
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
const { createOrg } = await import("@/lib/db/orgs");
const { ingestSegments } = await import("@/lib/segments/ingest");
const { seedTestSession } = await import("@/lib/testmeeting/feed");
const { FIXTURE_LINES, FIXTURE_SPEAKER_NAMES, toSegments } = await import("@/lib/testmeeting/fixture");
const { NameRoundError } = await import("@/lib/names/extract");
const { CHECKIN_PLACEHOLDER } = await import("@/lib/notes/checkin");

/**
 * A stand-in for Claude that really reads the name round: per label, the first
 * "Jag heter X Y" / "I'm X Y" / "X Y, <role>" it said.
 */
function readNames(segments: NameSegment[]): ExtractedName[] {
  const out = new Map<string, ExtractedName>();
  const name = "([A-ZÅÄÖ][a-zåäö]+ [A-ZÅÄÖ][a-zåäö]+)";
  const patterns = [new RegExp(`[Jj]ag heter ${name}`), new RegExp(`I'm ${name}`), new RegExp(`^${name},`)];
  for (const s of segments) {
    if (out.has(s.speaker)) continue;
    const hit = patterns.map((p) => p.exec(s.text)?.[1]).find(Boolean);
    if (hit) out.set(s.speaker, { elSessionId: s.el_session_id, speakerLabel: s.speaker, name: hit, needsConfirm: false });
  }
  return [...out.values()];
}

describe.skipIf(!hasLocalSupabase)("name round in the tick (Testmöte fixture)", () => {
  let starter: TestUser;
  let orgId: string;

  beforeAll(async () => {
    starter = await createTestUser("namer");
    const r = await createOrg(starter.db, "Båtklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  /** A live test meeting as POST /api/meetings/test makes it (session via seedTestSession). */
  async function testMeeting(kind: "test" | "live" = "test") {
    const id = randomUUID();
    const { error } = await adminClient().from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: "t.notes",
      transcript_tab_id: "t.transcript",
      status: "live",
      consent_confirmed_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    if (kind === "test") return { id, sessionId: await seedTestSession(id) };
    // A real (ElevenLabs) session, started 10 min ago so its round is due.
    const sessionId = `el-${randomUUID()}`;
    const started = new Date(Date.now() - 600_000).toISOString();
    await adminClient().from("meetings").update({ started_at: started }).eq("id", id);
    const { error: se } = await adminClient().from("el_sessions").insert({ id: sessionId, meeting_id: id, max_seconds: 3600, started_at: started });
    if (se) throw new Error(se.message);
    return { id, sessionId };
  }

  function fakes(extract: (segs: NameSegment[]) => Promise<ExtractedName[]>) {
    const appended: TranscriptLine[][] = [];
    const extractCalls: NameSegment[][] = [];
    const knownCalls: string[][] = [];
    const deps: Partial<import("@/lib/meetings/tick").TickDeps> = {
      getAuth: async () => ({}) as OAuth2Client,
      readNotes: async () => ({ revisionId: "r", tabId: "t.notes", paragraphs: [], ranges: new Map() }),
      render: async () => ({ status: "ok", rows: [], headerRendered: null }),
      appendTranscript: async (_a, _d, _t, lines) => void appended.push(lines),
      updateNotes: async (input: UpdateNotesInput): Promise<UpdateNotesResult> => ({
        ops: [],
        items: input.items,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 },
        stopReason: "end_turn",
        failure: null,
        dropped: 0,
        nextId: input.nextId ?? "n1",
      }),
      extractNames: async (segs, known) => {
        extractCalls.push(segs);
        knownCalls.push(known);
        return extract(segs);
      },
      mailer: { send: async () => false },
      sleep: async () => undefined,
    };
    return { deps, appended, extractCalls, knownCalls };
  }

  const feed = (id: string, sessionId: string, fromMs: number, toMs: number) => {
    const all = toSegments(FIXTURE_LINES, sessionId);
    return ingestSegments(id, all.filter((s) => s.startMs > fromMs && s.startMs <= toMs));
  };
  const backdate = (id: string) =>
    adminClient().from("meetings").update({ last_tick_at: new Date(Date.now() - 46_000).toISOString() }).eq("id", id);
  const speakerMap = async (id: string) =>
    Object.fromEntries(
      ((await adminClient().from("speaker_map").select("speaker_label, display_name").eq("meeting_id", id)).data ?? []).map((r) => [
        r.speaker_label,
        r.display_name,
      ]),
    );

  it("holds the transcript until the round, then maps all four fixture speakers", async () => {
    const { id, sessionId } = await testMeeting();
    expect(await speakerMap(id)).toEqual({}); // nothing seeded any more
    const f = fakes(async (segs) => readNames(segs));

    // First batch (the first 20 s): the round isn't due yet, so no transcript lines yet.
    await feed(id, sessionId, -1, 20_000);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(0);
    expect(f.appended).toHaveLength(0);

    // Past two minutes of speech: the round runs, then the transcript is written with names.
    await feed(id, sessionId, 20_000, 200_000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(1);
    expect(f.extractCalls[0][0].text).toContain("Jag heter Karin Ek");
    expect(await speakerMap(id)).toEqual(FIXTURE_SPEAKER_NAMES);
    const lines = f.appended.flat();
    expect(lines[0].speaker).toBe("Karin Ek");
    expect(new Set(lines.map((l) => l.speaker))).toEqual(new Set(Object.values(FIXTURE_SPEAKER_NAMES)));
    const { data: unwritten } = await adminClient().from("segments").select("segment_index").eq("meeting_id", id).is("transcript_written_at", null);
    expect(unwritten).toEqual([]);
    // A Testmöte session never touches the förening's people (I1): none added, none linked, none sent.
    const { data: people } = await adminClient().from("people").select("name").eq("org_id", orgId);
    expect(people).toEqual([]);
    const { data: links } = await adminClient().from("speaker_map").select("person_id").eq("meeting_id", id);
    expect(links?.every((l) => l.person_id === null)).toBe(true);
    const { data: events } = await adminClient().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "name_round");
    expect(events).toEqual([{ detail: expect.objectContaining({ ok: true, named: 4, unsure: 0 }) }]);

    // Once per session.
    await feed(id, sessionId, 200_000, 260_000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(1);
  });

  it("format layout: segments inside an open Må-runda window still reach the name round (masked for the notes only)", async () => {
    const { id, sessionId } = await testMeeting();
    await adminClient()
      .from("meetings")
      .update({ layout: "format", checkin_window: { startMs: 0, endMs: null, closed: false, failures: 0 } })
      .eq("id", id);
    const f = fakes(async (segs) => readNames(segs));
    const notes: UpdateNotesInput[] = [];
    const update = f.deps.updateNotes!;
    f.deps.updateNotes = async (input, opts) => {
      notes.push(input);
      return update(input, opts);
    };
    f.deps.detectCheckin = async () => ({ found: { startMs: null, endMs: null }, usage: null });
    await feed(id, sessionId, -1, 150_000);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(1);
    expect(f.extractCalls[0][0].text).toContain("Jag heter Karin Ek");
    expect(notes).toHaveLength(1);
    expect(notes[0].transcriptBlocks).toEqual([expect.stringContaining(CHECKIN_PLACEHOLDER)]);
    expect(notes[0].transcriptBlocks.join("\n")).not.toContain("Karin Ek");
  });

  it("a failed round never blocks the meeting: raw labels, a name_round event", async () => {
    const { id, sessionId } = await testMeeting();
    const f = fakes(async () => {
      throw new NameRoundError("request failed: timeout");
    });
    await feed(id, sessionId, -1, 150_000);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(1);
    expect(await speakerMap(id)).toEqual({});
    expect(f.appended.flat()[0].speaker).toBe("S1-speaker_0");
    const { data: events } = await adminClient().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "name_round");
    expect(events).toEqual([{ detail: expect.objectContaining({ ok: false, error: "request failed: timeout" }) }]);
  });

  it("the final pass runs a round that was not due yet, and never holds the transcript", async () => {
    const { id, sessionId } = await testMeeting();
    const f = fakes(async (segs) => readNames(segs));
    await feed(id, sessionId, -1, 20_000);
    await adminClient().from("meetings").update({ status: "ending", ended_at: new Date().toISOString() }).eq("id", id);
    expect(await tick.runTick(id, { final: true }, f.deps)).toBe("ok");
    expect(f.extractCalls).toHaveLength(1);
    expect(await speakerMap(id)).toEqual({ speaker_0: "Karin Ek", speaker_1: "Jonas Holm", speaker_2: "Leila Nasser" });
    expect(f.appended.flat().map((l) => l.speaker)).toEqual(["Karin Ek", "Jonas Holm", "Leila Nasser"]);
  });

  it("never overwrites a name someone picked; a clash with it needs confirming", async () => {
    const { id, sessionId } = await testMeeting();
    await feed(id, sessionId, -1, 150_000);
    await adminClient()
      .from("speaker_map")
      .insert({ meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_0", display_name: "Ordföranden" });
    // Claude names speaker_0 (already picked: left alone) and calls speaker_3 "Ordföranden" too.
    const f = fakes(async (segs) =>
      readNames(segs).map((n) => (n.speakerLabel === "speaker_3" ? { ...n, name: "Ordföranden" } : n)),
    );
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const { data } = await adminClient()
      .from("speaker_map")
      .select("speaker_label, display_name, needs_confirm")
      .eq("meeting_id", id)
      .order("speaker_label");
    expect(data).toEqual([
      { speaker_label: "speaker_0", display_name: "Ordföranden", needs_confirm: false },
      { speaker_label: "speaker_1", display_name: "Jonas Holm", needs_confirm: false },
      { speaker_label: "speaker_2", display_name: "Leila Nasser", needs_confirm: false },
      { speaker_label: "speaker_3", display_name: "Ordföranden", needs_confirm: true },
    ]);
  });

  it("live session (Ruling 36): only confident new full names join people; an exact one is linked; test sessions don't snap", async () => {
    const { data: known } = await adminClient().from("people").insert({ org_id: orgId, name: "Leila Nasser" }).select("id").single();
    // A Testmöte session gets no known people, so nothing can snap to a real person.
    const t = await testMeeting();
    const ft = fakes(async (segs) => readNames(segs));
    await feed(t.id, t.sessionId, -1, 150_000);
    expect(await tick.runTick(t.id, { final: false }, ft.deps)).toBe("ok");
    expect(ft.knownCalls).toEqual([[]]);

    const { id, sessionId } = await testMeeting("live");
    const f = fakes(async (segs) =>
      readNames(segs).map((n) =>
        n.speakerLabel === "speaker_1" ? { ...n, name: "Jonas" } : n.speakerLabel === "speaker_3" ? { ...n, needsConfirm: true } : n,
      ),
    );
    await feed(id, sessionId, -1, 150_000);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.knownCalls[0]).toContain("Leila Nasser");
    const { data: rows } = await adminClient()
      .from("speaker_map")
      .select("speaker_label, display_name, person_id, needs_confirm")
      .eq("meeting_id", id)
      .order("speaker_label");
    const { data: people } = await adminClient().from("people").select("id, name").eq("org_id", orgId).order("name");
    expect(people!.map((p) => p.name)).toEqual(["Karin Ek", "Leila Nasser"]); // not "Jonas" (one word), not Daniel (unsure)
    const karin = people!.find((p) => p.name === "Karin Ek")!.id;
    expect(rows).toEqual([
      { speaker_label: "speaker_0", display_name: "Karin Ek", person_id: karin, needs_confirm: false },
      { speaker_label: "speaker_1", display_name: "Jonas", person_id: null, needs_confirm: false },
      { speaker_label: "speaker_2", display_name: "Leila Nasser", person_id: known!.id, needs_confirm: false },
      { speaker_label: "speaker_3", display_name: "Daniel Brooks", person_id: null, needs_confirm: true },
    ]);
  });
});
