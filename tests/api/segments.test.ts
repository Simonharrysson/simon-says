import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

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

  it("applies merges to speaker_map", async () => {
    const m = await meeting();
    const s = await session(m);
    await adminClient().from("speaker_map").insert({ meeting_id: m, el_session_id: s, speaker_label: "speaker_0", display_name: "Anna" });
    await ingestSegments(m, [], [{ elSessionId: s, from: ["speaker_1", "speaker_2"], into: "speaker_0" }]);
    const { data } = await adminClient().from("speaker_map").select("speaker_label, display_name").eq("meeting_id", m);
    expect(data!.filter((r) => r.display_name === "Anna")).toHaveLength(3);
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
      const res = await call(postSegments, m, { segments: [run(s, 0)] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ stored: 1, received: 1 });
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
