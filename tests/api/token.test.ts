import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// The token route against the local stack as a real signed-in user. ElevenLabs is mocked
// (mintToken only; the wsUrl builder is real). The env points the service-role client at the
// local stack; tests flip KILL_SWITCH and lower the global caps through `envOverride` (so no
// test writes global usage big enough to trip other test files sharing the database).
const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

const envOverride = vi.hoisted(() => ({}) as { KILL_SWITCH?: boolean; GLOBAL_DAILY_HOURS?: number; GLOBAL_DAILY_USD?: number });
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

const mint = vi.hoisted(() => ({ fn: vi.fn(async (_maxSessionSeconds: number) => "tok-test") }));
vi.mock("@/lib/elevenlabs/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/elevenlabs/token")>()),
  mintToken: mint.fn,
}));

const { POST } = await import("@/app/api/meetings/[id]/token/route");

const as = (user: TestUser | null) => {
  current.db = user ? user.db : anonClient();
};

const callToken = (id: string, body?: Record<string, unknown>) =>
  POST(
    new NextRequest(`https://x.test/api/meetings/${id}/token`, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

/** A live meeting (consent confirmed unless told otherwise), written as the server would. */
async function liveMeeting(orgId: string, startedBy: string, opts: { consent?: boolean; status?: string } = {}) {
  const { data, error } = await adminClient()
    .from("meetings")
    .insert({
      org_id: orgId,
      started_by: startedBy,
      doc_id: "doc",
      notes_tab_id: "t.notes",
      status: opts.status ?? "live",
      consent_confirmed_at: opts.consent === false ? null : new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed meeting: ${error.message}`);
  return data.id as string;
}

async function meetingRow(id: string) {
  const { data } = await adminClient()
    .from("meetings")
    .select("current_el_session_id, last_heartbeat_at")
    .eq("id", id)
    .single();
  return data!;
}

async function sessionRow(id: string) {
  const { data } = await adminClient().from("el_sessions").select("*").eq("id", id).single();
  return data!;
}

async function orgSecondsToday(orgId: string): Promise<number> {
  const { data } = await adminClient().from("usage_daily").select("seconds").eq("org_id", orgId).eq("day", today());
  return (data ?? []).reduce((s, r) => s + Number(r.seconds), 0);
}

/** Move a session's start (and the meeting's heartbeat) into the past, as if time passed. */
async function age(meetingId: string, sessionId: string, seconds: number, heartbeatAgo = 0) {
  const past = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  await adminClient().from("el_sessions").update({ started_at: past(seconds) }).eq("id", sessionId);
  await adminClient().from("meetings").update({ last_heartbeat_at: past(heartbeatAgo) }).eq("id", meetingId);
}

/** A small usage row for a made-up (e.g. deleted) org, so global sums see it. Removed in `finally`. */
async function withGlobalUsage(row: { seconds?: number; usd?: number }, fn: () => Promise<void>) {
  const orgId = randomUUID();
  const { error } = await adminClient().from("usage_daily").insert({ org_id: orgId, day: today(), ...row });
  if (error) throw new Error(`seed usage: ${error.message}`);
  try {
    await fn();
  } finally {
    await adminClient().from("usage_daily").delete().eq("org_id", orgId);
  }
}

describe.skipIf(!hasLocalSupabase)("POST /api/meetings/[id]/token", () => {
  let starter: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  const meetings: string[] = [];
  const live = async (...args: Parameters<typeof liveMeeting>) => {
    const id = await liveMeeting(...args);
    meetings.push(id);
    return id;
  };

  beforeAll(async () => {
    [starter, member, outsider] = await Promise.all([
      createTestUser("starter"),
      createTestUser("member"),
      createTestUser("outsider"),
    ]);
    const r = await createOrg(starter.db, "Styrelsen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    expect(await joinOrg(member.db, await inviteCode(orgId))).toBe(orgId);
  });

  beforeEach(() => {
    mint.fn.mockClear();
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof typeof envOverride];
  });

  afterAll(async () => {
    // Settle the sessions these tests left open, so they don't count as running usage.
    const { data } = await adminClient().from("el_sessions").select("id").in("meeting_id", meetings).is("closed_at", null);
    for (const s of data ?? []) await adminClient().rpc("close_el_session", { p_session_id: s.id });
  });

  it("401 signed out", async () => {
    as(null);
    expect((await callToken(randomUUID())).status).toBe(401);
  });

  it("403 for a member who didn't start the meeting, 404 for outsiders and bad ids", async () => {
    const id = await live(orgId, starter.id);
    as(member);
    const res = await callToken(id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_starter" });
    as(outsider);
    expect((await callToken(id)).status).toBe(404);
    as(starter);
    expect((await callToken("not-a-uuid")).status).toBe(404);
    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("403 without confirmed consent", async () => {
    const id = await live(orgId, starter.id, { consent: false });
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_consent" });
    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("409 when the meeting isn't live", async () => {
    const id = await live(orgId, starter.id, { status: "done" });
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_live" });
  });

  it("mints with max_session_duration_seconds = the remaining meeting time (14 400 at start, never 900)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toBe("tok-test");
    expect(typeof body.sessionId).toBe("string");

    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect(mint.fn).toHaveBeenCalledWith(14_400);

    const ws = new URL(body.wsUrl);
    expect(ws.origin + ws.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    for (const [k, v] of Object.entries({
      model_id: "scribe_v3_live",
      diarize: "true",
      multilang_mode: "true",
      include_timestamps: "true",
      include_language_detection: "true",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
    })) {
      expect(ws.searchParams.get(k), k).toBe(v);
    }
    expect(ws.searchParams.has("token")).toBe(false);

    const session = await sessionRow(body.sessionId);
    expect(session).toMatchObject({ meeting_id: id, max_seconds: 14_400, closed_at: null });
    expect((await meetingRow(id)).current_el_session_id).toBe(body.sessionId);
  });

  it("409 for a second token while the session is open and no (or a wrong) closingSessionId", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await callToken(id);
    expect(first.status).toBe(200);
    const { sessionId } = await first.json();

    for (const body of [undefined, {}, { closingSessionId: "some-other-session" }]) {
      const res = await callToken(id, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "session_open" });
    }
    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect((await meetingRow(id)).current_el_session_id).toBe(sessionId);
    expect((await sessionRow(sessionId)).closed_at).toBeNull();
  });

  it("reconnect: socket drops, a request 1 s later with closingSessionId succeeds; usage from server times only", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    // Two minutes of the session have passed (server time).
    await age(id, first.sessionId, 120);
    const before = await orgSecondsToday(orgId);

    await sleep(1000);
    // Client-reported numbers are ignored.
    const res = await callToken(id, { closingSessionId: first.sessionId, seconds: 99_999, usedSeconds: 99_999 });
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.sessionId).not.toBe(first.sessionId);

    const closed = await sessionRow(first.sessionId);
    expect(closed.closed_at).not.toBeNull();
    const booked = (await orgSecondsToday(orgId)) - before;
    expect(booked).toBeGreaterThanOrEqual(120);
    expect(booked).toBeLessThanOrEqual(125);

    // The new session gets the rest of the 4 h.
    const max = mint.fn.mock.calls[1][0];
    expect(max).toBeGreaterThanOrEqual(14_400 - 125);
    expect(max).toBeLessThanOrEqual(14_400 - 120);
    expect((await sessionRow(second.sessionId)).max_seconds).toBe(max);
    expect((await meetingRow(id)).current_el_session_id).toBe(second.sessionId);

    // The reconnect is logged; closing the same session again is refused (it's not current).
    const { data: events } = await adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id);
    expect(events).toEqual([{ kind: "reconnect", detail: { closed: first.sessionId, sessionId: second.sessionId } }]);
    expect((await callToken(id, { closingSessionId: first.sessionId })).status).toBe(409);
  });

  it("two concurrent reconnects with the same closingSessionId: exactly one wins", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    const results = await Promise.all([
      callToken(id, { closingSessionId: first.sessionId }),
      callToken(id, { closingSessionId: first.sessionId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await results.find((r) => r.status === 200)!.json();
    expect((await meetingRow(id)).current_el_session_id).toBe(winner.sessionId);
    const { data: open } = await adminClient().from("el_sessions").select("id").eq("meeting_id", id).is("closed_at", null);
    expect(open).toEqual([{ id: winner.sessionId }]);
  });

  it("a session past started_at + max_seconds is counted only up to max_seconds and can be replaced", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    // Shrink it to 60 s and let 10 minutes pass: ElevenLabs closed it at 60 s.
    await adminClient().from("el_sessions").update({ max_seconds: 60 }).eq("id", first.sessionId);
    await age(id, first.sessionId, 600);
    const before = await orgSecondsToday(orgId);

    expect((await callToken(id)).status).toBe(200);
    expect((await orgSecondsToday(orgId)) - before).toBe(60);
  });

  it("allows a new token after the page has been silent for > 60 s, and closes the abandoned session", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    await age(id, first.sessionId, 90, 50);
    expect((await callToken(id)).status).toBe(409);

    await age(id, first.sessionId, 90, 61);
    const res = await callToken(id);
    expect(res.status).toBe(200);
    expect((await sessionRow(first.sessionId)).closed_at).not.toBeNull();
  });

  it("a failed mint closes the claimed session (502), so the next request gets a token", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    mint.fn.mockRejectedValueOnce(new Error("ElevenLabs 401: quota_exceeded"));
    const res = await callToken(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mint_failed" });
    const { current_el_session_id } = await meetingRow(id);
    expect((await sessionRow(current_el_session_id!)).closed_at).not.toBeNull();

    expect((await callToken(id)).status).toBe(200);
  });

  it("429 at 20 h for the org this month", async () => {
    const r = await createOrg(starter.db, "Full org");
    if (!r.ok) throw new Error("org");
    await adminClient().from("usage_daily").insert({ org_id: r.id, day: today(), seconds: 20 * 3600 });
    const id = await live(r.id, starter.id);
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "org_month" });
    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("429 at 4 h for the meeting", async () => {
    const id = await live(orgId, starter.id);
    const start = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    await adminClient()
      .from("el_sessions")
      .insert({ id: `old-${randomUUID()}`, meeting_id: id, started_at: start, max_seconds: 14_400, closed_at: new Date().toISOString() });
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "meeting_length" });
  });

  it("429 at the global daily hours cap (counted across orgs, incl. deleted ones)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const { data: used } = await adminClient().rpc("global_day_seconds");
    // Cap = what's used today + 60 s; another org's 60 s today reaches it.
    envOverride.GLOBAL_DAILY_HOURS = (Number(used) + 60) / 3600;
    await withGlobalUsage({ seconds: 60 }, async () => {
      const res = await callToken(id);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "global_day" });
    });
  });

  it("429 at the global daily dollar cap (counted across orgs, incl. deleted ones)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const { data: rows } = await adminClient().from("usage_daily").select("usd").eq("day", today());
    const spent = (rows ?? []).reduce((s, r) => s + Number(r.usd), 0);
    envOverride.GLOBAL_DAILY_USD = spent + 0.5;
    await withGlobalUsage({ usd: 0.5 }, async () => {
      const res = await callToken(id);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "global_usd" });
    });
  });

  it("503 with KILL_SWITCH=1", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    envOverride.KILL_SWITCH = true;
    const res = await callToken(id);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kill_switch" });
    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("the session functions are service-role only", async () => {
    for (const [fn, args] of [
      ["close_el_session", { p_session_id: "x" }],
      ["begin_el_session", { p_meeting_id: randomUUID(), p_new_session_id: "x", p_max_seconds: 1, p_closing_session_id: null }],
      ["meeting_seconds", { p_meeting_id: randomUUID() }],
      ["global_day_seconds", {}],
    ] as const) {
      const { error } = await starter.db.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
  });
});
