import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";
import { resolveSpeaker, type SpeakerMapRow } from "@/lib/segments/resolve";

const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));
// after() needs a Next request scope; record the scheduled tasks instead (the tick is tested in tests/meetings).
const scheduled = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    scheduled.push(task);
  },
}));
const ticked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/meetings/tick", () => ({ maybeTick: async (id: string) => void ticked.push(id) }));

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

const { POST: postSegments } = await import("@/app/api/meetings/[id]/segments/route");
const { POST: postHeartbeat } = await import("@/app/api/meetings/[id]/heartbeat/route");
const { ingestSegments, IngestError } = await import("@/lib/segments/ingest");

const as = (user: TestUser | null) => {
  current.db = user ? user.db : anonClient();
};

const call = (handler: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body?: unknown) =>
  handler(
    new NextRequest(`https://x.test/api/meetings/${id}/x`, {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );

const run = (sessionId: string, segmentIndex: number, runIndex = 0, over: Record<string, unknown> = {}) => ({
  elSessionId: sessionId,
  segmentIndex,
  runIndex,
  speaker: "speaker_0",
  text: `text ${segmentIndex}.${runIndex}`,
  startMs: 1000 * segmentIndex,
  endMs: 1000 * segmentIndex + 500,
  ...over,
});

describe("resolveSpeaker", () => {
  const rows: SpeakerMapRow[] = [
    { speaker_label: "A", display_name: "A", merged_into_label: "B" },
    { speaker_label: "B", display_name: "B", merged_into_label: "C" },
    { speaker_label: "C", display_name: "Anna", person_id: "p1" },
    { speaker_label: "X", display_name: "X", merged_into_label: "Y" },
    { speaker_label: "Y", display_name: "Y", merged_into_label: "X" },
  ];
  it("follows chains, falls back to the label, survives cycles", () => {
    expect(resolveSpeaker(rows, "A")).toEqual({ label: "C", displayName: "Anna", personId: "p1" });
    expect(resolveSpeaker(rows, "Z")).toEqual({ label: "Z", displayName: "Z", personId: null });
    expect(resolveSpeaker(rows, "X").label).toBeTruthy();
  });
});

// Validation happens before any database access, so these run without the local stack.
describe("ingestSegments validation", () => {
  const id = randomUUID();
  it("rejects text over 2 000 chars", async () => {
    await expect(ingestSegments(id, [run("s", 0, 0, { text: "x".repeat(2001) })])).rejects.toMatchObject({
      code: "text_too_long",
      status: 413,
    });
  });
  it("rejects malformed input", async () => {
    for (const bad of [
      "nope",
      [{}],
      [run("s", -1)],
      [run("s", 0, 0, { text: "  " })],
      [run("s", 0, 0, { startMs: 5, endMs: 1 })],
      [run("", 0)],
    ]) {
      await expect(ingestSegments(id, bad)).rejects.toBeInstanceOf(IngestError);
    }
    await expect(ingestSegments(id, [], [{ elSessionId: "s", from: [], into: "a" }])).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe.skipIf(!hasLocalSupabase)("segment ingest + heartbeat", () => {
  let starter: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [starter, member] = await Promise.all([createTestUser("starter"), createTestUser("member")]);
    const r = await createOrg(starter.db, "Styrelsen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  async function meeting(opts: { status?: string; startedAgoSec?: number } = {}) {
    const startedAt = new Date(Date.now() - (opts.startedAgoSec ?? 0) * 1000).toISOString();
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({
        org_id: orgId,
        started_by: starter.id,
        doc_id: "doc",
        notes_tab_id: "t",
        status: opts.status ?? "live",
        consent_confirmed_at: new Date().toISOString(),
        started_at: startedAt,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }
  async function session(meetingId: string, opts: { startedAgoSec?: number; closed?: boolean } = {}) {
    const id = `el-${randomUUID()}`;
    const { error } = await adminClient()
      .from("el_sessions")
      .insert({
        id,
        meeting_id: meetingId,
        max_seconds: 3600,
        started_at: new Date(Date.now() - (opts.startedAgoSec ?? 0) * 1000).toISOString(),
        closed_at: opts.closed ? new Date(Date.now() - 5000).toISOString() : null,
      });
    if (error) throw new Error(error.message);
    return id;
  }
  const rows = async (meetingId: string) =>
    (await adminClient().from("segments").select("*").eq("meeting_id", meetingId).order("start_ms")).data!;

  it("stores the same batch once", async () => {
    const m = await meeting();
    const s = await session(m);
    const batch = [run(s, 0), run(s, 0, 1), run(s, 1)];
    expect(await ingestSegments(m, batch)).toEqual({ stored: 3, received: 3 });
    expect(await ingestSegments(m, batch)).toEqual({ stored: 0, received: 3 });
    expect(await rows(m)).toHaveLength(3);
  });

  it("does not overwrite an existing key with different text", async () => {
    const m = await meeting();
    const s = await session(m);
    await ingestSegments(m, [run(s, 0)]);
    await ingestSegments(m, [run(s, 0, 0, { text: "changed" })]);
    expect((await rows(m))[0].text).toBe("text 0.0");
  });

  it("accepts a batch for a session closed 5 s ago", async () => {
    const m = await meeting();
    const s = await session(m, { closed: true });
    expect((await ingestSegments(m, [run(s, 0)])).stored).toBe(1);
  });

  it("409 for a session of another meeting or an unknown one", async () => {
    const m = await meeting();
    const other = await meeting();
    const foreign = await session(other);
    await expect(ingestSegments(m, [run(foreign, 0)])).rejects.toMatchObject({ status: 409 });
    await expect(ingestSegments(m, [run("el-unknown", 0)])).rejects.toMatchObject({ status: 409 });
    expect(await rows(m)).toHaveLength(0);
  });

  it("409 for done and abandoned meetings", async () => {
    for (const status of ["done", "abandoned"]) {
      const m = await meeting({ status });
      const s = await session(m);
      await expect(ingestSegments(m, [run(s, 0)])).rejects.toMatchObject({ code: "meeting_not_live", status: 409 });
    }
  });

  it("429 above 120 runs per minute", async () => {
    const m = await meeting();
    const s = await session(m);
    const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => run(s, from + i));
    expect((await ingestSegments(m, mk(0, 100))).stored).toBe(100);
    await expect(ingestSegments(m, mk(100, 21))).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect((await ingestSegments(m, mk(100, 20))).stored).toBe(20);
    await expect(ingestSegments(m, mk(120, 1))).rejects.toMatchObject({ status: 429 });
  });

  it("converts to meeting-relative ms across two sessions", async () => {
    const m = await meeting({ startedAgoSec: 100 });
    const s1 = await session(m, { startedAgoSec: 100, closed: true });
    const s2 = await session(m, { startedAgoSec: 40 });
    await ingestSegments(m, [run(s1, 0, 0, { startMs: 1000, endMs: 2000 }), run(s2, 0, 0, { startMs: 1000, endMs: 2000 })]);
    const [a, b] = await rows(m);
    expect(a.start_ms).toBeGreaterThanOrEqual(900);
    expect(a.start_ms).toBeLessThan(1200);
    expect(b.start_ms - a.start_ms).toBeGreaterThan(59_000);
    expect(b.start_ms - a.start_ms).toBeLessThan(61_000);
    expect(b.end_ms - b.start_ms).toBe(1000);
  });

  it("resend of stored keys does not count against the cap", async () => {
    const m = await meeting();
    const s = await session(m);
    const batch = Array.from({ length: 120 }, (_, i) => run(s, i));
    expect((await ingestSegments(m, batch)).stored).toBe(120);
    expect(await ingestSegments(m, batch)).toEqual({ stored: 0, received: 120 });
  });

  it("parallel requests cannot exceed 120 runs/min", async () => {
    const m = await meeting();
    const s = await session(m);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, k) =>
        ingestSegments(m, Array.from({ length: 30 }, (_, i) => run(s, k * 30 + i))),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(await rows(m)).toHaveLength(120);
  });

  it("429 above 20 000 chars per minute", async () => {
    const m = await meeting();
    const s = await session(m);
    const big = (i: number) => run(s, i, 0, { text: "x".repeat(2000) });
    expect((await ingestSegments(m, Array.from({ length: 10 }, (_, i) => big(i)))).stored).toBe(10);
    await expect(ingestSegments(m, [big(10)])).rejects.toMatchObject({ code: "chars_per_min", status: 429 });
  });

  it("413 above 600 000 chars per meeting", async () => {
    const m = await meeting();
    const s = await session(m);
    const old = new Date(Date.now() - 3600_000).toISOString();
    const seed = Array.from({ length: 300 }, (_, i) => ({
      meeting_id: m, el_session_id: s, segment_index: 1000 + i, run_index: 0, speaker: "a",
      text: "x".repeat(2000), start_ms: 0, end_ms: 1, created_at: old,
    }));
    expect((await adminClient().from("segments").insert(seed)).error).toBeNull();
    await expect(ingestSegments(m, [run(s, 0)])).rejects.toMatchObject({ code: "chars_total", status: 413 });
  });

  it("rejects times beyond the session's length", async () => {
    const m = await meeting();
    const s = await session(m); // max_seconds 3600
    await expect(ingestSegments(m, [run(s, 0, 0, { startMs: 0, endMs: 3_660_001 })])).rejects.toMatchObject({ status: 400 });
    expect((await ingestSegments(m, [run(s, 0, 0, { startMs: 0, endMs: 3_660_000 })])).stored).toBe(1);
  });

  const labelsOf = async (m: string, s: string) =>
    ((await adminClient().from("speaker_map").select("*").eq("meeting_id", m).eq("el_session_id", s)).data ?? []) as SpeakerMapRow[];

  it("merge before the target is identified resolves to its name later; chains A->B->C", async () => {
    const m = await meeting();
    const s = await session(m);
    await ingestSegments(m, [
      run(s, 0, 0, { speaker: "A" }), run(s, 1, 0, { speaker: "B" }), run(s, 2, 0, { speaker: "C" }),
    ]);
    await ingestSegments(m, [], [{ elSessionId: s, from: ["A"], into: "B" }]);
    await ingestSegments(m, [], [{ elSessionId: s, from: ["B"], into: "C" }]);
    expect(resolveSpeaker(await labelsOf(m, s), "A")).toMatchObject({ label: "C", displayName: "C" });
    await adminClient().from("speaker_map").insert({ meeting_id: m, el_session_id: s, speaker_label: "C", display_name: "Anna" });
    expect(resolveSpeaker(await labelsOf(m, s), "A").displayName).toBe("Anna");
    expect(resolveSpeaker(await labelsOf(m, s), "B").displayName).toBe("Anna");
  });

  it("merge: unknown from-label, cycles, and the run budget", async () => {
    const m = await meeting();
    const s = await session(m);
    await ingestSegments(m, [run(s, 0, 0, { speaker: "A" }), run(s, 1, 0, { speaker: "B" })]);
    await expect(ingestSegments(m, [], [{ elSessionId: s, from: ["ghost"], into: "A" }])).rejects.toMatchObject({
      code: "unknown_speaker",
    });
    await ingestSegments(m, [], [{ elSessionId: s, from: ["A"], into: "B" }]);
    await expect(ingestSegments(m, [], [{ elSessionId: s, from: ["B"], into: "A" }])).rejects.toMatchObject({
      code: "merge_cycle",
    });
    // merged labels count as runs: 2 runs stored, so 119 labels would exceed 120
    const many = Array.from({ length: 119 }, (_, i) => `L${i}`);
    await expect(ingestSegments(m, [], [
      { elSessionId: s, from: many.slice(0, 50), into: "B" },
      { elSessionId: s, from: many.slice(50, 100), into: "B" },
      { elSessionId: s, from: many.slice(100), into: "B" },
    ])).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  describe("routes", () => {
    it("segments: 401, 403 non-starter, 404 bad id, 200 ok", async () => {
      const m = await meeting();
      const s = await session(m);
      as(null);
      expect((await call(postSegments, m, { segments: [] })).status).toBe(401);
      as(member);
      expect((await call(postSegments, m, { segments: [] })).status).toBe(404); // not in org
      as(starter);
      expect((await call(postSegments, "nope", { segments: [] })).status).toBe(404);
      expect((await call(postSegments, m, "x")).status).toBe(400);
      scheduled.length = 0;
      const res = await call(postSegments, m, { segments: [run(s, 0)] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ stored: 1, received: 1 });
      // A notes tick is scheduled after the response.
      expect(scheduled).toHaveLength(1);
      await scheduled[0]();
      expect(ticked).toContain(m);
    });

    it("segments: maps ingest errors to status codes", async () => {
      const m = await meeting({ status: "done" });
      as(starter);
      const res = await call(postSegments, m, { segments: [run("x", 0)] });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "meeting_not_live" });
    });

    it("heartbeat: sets last_heartbeat_at only and returns warn/stop", async () => {
      const m = await meeting();
      as(starter);
      const res = await call(postHeartbeat, m);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ warn: false, stop: false });
      const { data } = await adminClient().from("meetings").select("last_heartbeat_at, status").eq("id", m).single();
      expect(data!.last_heartbeat_at).not.toBeNull();
      expect(data!.status).toBe("live");
    });

    it("heartbeat: still answers under the kill switch (stop)", async () => {
      const m = await meeting();
      as(starter);
      envOverride.KILL_SWITCH = true;
      const res = await call(postHeartbeat, m);
      expect(res.status).toBe(200);
      expect((await res.json()).stop).toBe(true);
    });

    it("heartbeat: 401 / 404 / 409 done", async () => {
      const m = await meeting({ status: "done" });
      as(null);
      expect((await call(postHeartbeat, m)).status).toBe(401);
      as(starter);
      expect((await call(postHeartbeat, "nope")).status).toBe(404);
      expect((await call(postHeartbeat, m)).status).toBe(409);
    });
  });
});
