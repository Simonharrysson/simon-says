import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// The token route against the local stack as a real signed-in user. ElevenLabs is mocked
// (mintToken only; the wsUrl builder is real). The env points the service-role client at the
// local stack. The global caps are effectively off by default (`envOverride`), because other
// test files share the database and their open sessions count globally; the global-cap tests
// lower them explicitly.
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

async function orgUsageToday(orgId: string): Promise<{ seconds: number; usd: number }> {
  const { data } = await adminClient().from("usage_daily").select("seconds, usd").eq("org_id", orgId).eq("day", today());
  const row = data?.[0];
  return { seconds: Number(row?.seconds ?? 0), usd: Number(row?.usd ?? 0) };
}
const orgSecondsToday = async (orgId: string) => (await orgUsageToday(orgId)).seconds;

/** Move a session's start (and the meeting's heartbeat) into the past, as if time passed. */
async function age(meetingId: string, sessionId: string, seconds: number, heartbeatAgo = 0) {
  const past = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  await adminClient().from("el_sessions").update({ started_at: past(seconds) }).eq("id", sessionId);
  await adminClient().from("meetings").update({ last_heartbeat_at: past(heartbeatAgo) }).eq("id", meetingId);
}

/** A usage row for a made-up (e.g. deleted) org, so global sums see it. Removed in `finally`. */
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

const WS_PARAMS = {
  model_id: "scribe_v3_live",
  diarize: "true",
  multilang_mode: "true",
  include_timestamps: "true",
  include_language_detection: "true",
  audio_format: "pcm_16000",
  commit_strategy: "vad",
};

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
  /** A fresh org of its own (each user may create two). */
  const freshOrg = async (name: string) => {
    const owner = await createTestUser("owner");
    const r = await createOrg(owner.db, name);
    if (!r.ok) throw new Error("org");
    return { owner, orgId: r.id };
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
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  afterEach(async () => {
    // Settle the sessions each test left open: open sessions reserve org time for later tests.
    const { data } = await adminClient().from("el_sessions").select("id").in("meeting_id", meetings).is("closed_at", null);
    for (const s of data ?? []) await adminClient().rpc("close_el_session", { p_session_id: s.id, p_usd_per_hour: 0 });
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

  it("mints with max_session_duration_seconds = least(remaining time, 1 h) (3 600 at start, Ruling 39)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const res = await callToken(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toBe("tok-test");
    expect(typeof body.sessionId).toBe("string");

    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect(mint.fn).toHaveBeenCalledWith(3600);

    const ws = new URL(body.wsUrl);
    expect(ws.origin + ws.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    for (const [k, v] of Object.entries(WS_PARAMS)) expect(ws.searchParams.get(k), k).toBe(v);
    expect(ws.searchParams.has("token")).toBe(false);

    const session = await sessionRow(body.sessionId);
    expect(session).toMatchObject({ meeting_id: id, max_seconds: 3600, closed_at: null });
    expect((await meetingRow(id)).current_el_session_id).toBe(body.sessionId);
  });

  it("dev override (ELEVENLABS_WS_URL): the session is booked as 'test' (no ElevenLabs hours or dollars)", async () => {
    vi.stubEnv("ELEVENLABS_WS_URL", "ws://127.0.0.1:8787/v1/speech-to-text/realtime");
    try {
      const id = await live(orgId, starter.id);
      as(starter);
      const res = await callToken(id);
      expect(res.status).toBe(200);
      const { sessionId, wsUrl } = await res.json();
      expect(wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:8787\//);
      const { data } = await adminClient().from("el_sessions").select("kind").eq("id", sessionId).single();
      expect(data!.kind).toBe("test");
    } finally {
      vi.unstubAllEnvs();
    }
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
      // The starter learns which session is open, so a lost token response can't wedge the meeting.
      expect(await res.json()).toEqual({ error: "session_open", openSessionId: sessionId });
    }
    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect((await meetingRow(id)).current_el_session_id).toBe(sessionId);
    expect((await sessionRow(sessionId)).closed_at).toBeNull();
  });

  it("reconnect: socket drops, a request 1 s later with closingSessionId succeeds; the closed session is booked in full", async () => {
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
    // Ruling 39: ElevenLabs may keep billing the old socket up to its granted hour, so the
    // whole granted length is booked, not the 2 minutes it ran.
    expect((await orgSecondsToday(orgId)) - before).toBe(3600);

    // The new session gets another hour (the meeting's 4 h cap counts elapsed time).
    const max = mint.fn.mock.calls[1][0];
    expect(max).toBe(3600);
    expect((await sessionRow(second.sessionId)).max_seconds).toBe(max);
    expect((await meetingRow(id)).current_el_session_id).toBe(second.sessionId);

    // The reconnect is logged; closing the same session again is refused (it's not current).
    const { data: events } = await adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id);
    expect(events).toEqual([{ kind: "reconnect", detail: { closed: first.sessionId, sessionId: second.sessionId } }]);
    expect((await callToken(id, { closingSessionId: first.sessionId })).status).toBe(409);
  });

  it("books ElevenLabs dollars on close: seconds / 3600 × ELEVENLABS_USD_PER_HOUR (default 0.22)", async () => {
    const { owner, orgId: org } = await freshOrg("Dollar org");
    const id = await live(org, owner.id);
    as(owner);
    const first = await (await callToken(id)).json();
    await age(id, first.sessionId, 3600);
    expect((await callToken(id, { closingSessionId: first.sessionId })).status).toBe(200);
    const { seconds, usd } = await orgUsageToday(org);
    expect(seconds).toBe(3600);
    expect(usd).toBeCloseTo((seconds / 3600) * 0.22, 5);
  });

  it("two concurrent reconnects with the same closingSessionId: exactly one wins", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    await age(id, first.sessionId, 30);
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

  it("two simultaneous first mints in one org near its cap: the second gets only what's left after the first's reservation", async () => {
    const { owner, orgId: org } = await freshOrg("Nearly full");
    // 5 000 s left this month. The first session takes 3 600 (the 1 h session cap) and reserves
    // exactly that (its close books it in full), leaving 1 400 for the second.
    await adminClient().from("usage_daily").insert({ org_id: org, day: today(), seconds: 20 * 3600 - 5000 });
    const [a, b] = [await live(org, owner.id), await live(org, owner.id)];
    as(owner);
    const results = await Promise.all([callToken(a), callToken(b)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(mint.fn.mock.calls.map((c) => c[0]).sort((x, y) => x - y)).toEqual([1400, 3600]);

    // A third meeting now has nothing left: 429, no mint.
    const c = await live(org, owner.id);
    const third = await callToken(c);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "org_month" });
    expect(mint.fn).toHaveBeenCalledTimes(2);
  });

  it("a session past its window end (started_at + max_seconds + 900 s) is booked at max_seconds and can be replaced", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    // Shrink it to 60 s; at 900 s after the mint it may still run (token window) → busy.
    await adminClient().from("el_sessions").update({ max_seconds: 60 }).eq("id", first.sessionId);
    await age(id, first.sessionId, 900);
    expect((await callToken(id)).status).toBe(409);

    // 20 minutes after the mint it is over: booked its granted 60 s (all ElevenLabs can bill).
    await age(id, first.sessionId, 1200);
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

  it("a failed mint releases the claimed session (502, nothing booked), so a request after the 5 s spacing gets a token", async () => {
    const { owner, orgId: org } = await freshOrg("Mint fails");
    const id = await live(org, owner.id);
    as(owner);
    mint.fn.mockRejectedValueOnce(new Error("ElevenLabs 401: quota_exceeded"));
    const res = await callToken(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mint_failed" });
    const { current_el_session_id } = await meetingRow(id);
    const released = await sessionRow(current_el_session_id!);
    expect(released.closed_at).not.toBeNull();
    expect(released.kind).toBe("unminted");
    expect(await orgSecondsToday(org)).toBe(0);

    expect((await callToken(id)).status).toBe(429); // within 5 s
    await age(id, current_el_session_id!, 6);
    expect((await callToken(id)).status).toBe(200);
  });

  it("429 reconnect_limit: at most one mint per 5 s per meeting (the open session stays open)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    const first = await (await callToken(id)).json();
    const res = await callToken(id, { closingSessionId: first.sessionId });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("reconnect_limit");
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(body.retryAfter).toBeLessThanOrEqual(5);
    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect((await sessionRow(first.sessionId)).closed_at).toBeNull();
    expect((await meetingRow(id)).current_el_session_id).toBe(first.sessionId);

    await age(id, first.sessionId, 6);
    expect((await callToken(id, { closingSessionId: first.sessionId })).status).toBe(200);
  });

  it("R2: the mint spacing grows with the meeting's live mints (5 s up to 4, then doubling, max 10 min)", async () => {
    // An org of its own: closed sessions book full hours, so the shared org's month may be used up.
    const { owner, orgId: org } = await freshOrg("Spacing org");
    const id = await live(org, owner.id);
    const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
    // 6 earlier live mints, the last 60 s ago: spacing 5 × 2^(6−4) = 20 s → allowed. (Older than
    // the 41 s the 7th mint is aged to below, so the 7th stays the newest start.)
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `sp-${randomUUID()}`,
      meeting_id: id,
      started_at: ago(i === 5 ? 60 : 3600),
      max_seconds: 1,
      closed_at: ago(i === 5 ? 59 : 3599),
    }));
    await adminClient().from("el_sessions").insert(rows);
    as(owner);
    expect((await callToken(id)).status).toBe(200); // 7th mint
    // Now 7 live mints: spacing 40 s. 30 s after the 7th mint: refused, told to wait ~10 s.
    const { current_el_session_id: cur } = await meetingRow(id);
    await age(id, cur!, 30);
    const res = await callToken(id, { closingSessionId: cur });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("reconnect_limit");
    expect(body.retryAfter).toBeGreaterThanOrEqual(9);
    expect(body.retryAfter).toBeLessThanOrEqual(11);
    await age(id, cur!, 41);
    expect((await callToken(id, { closingSessionId: cur })).status).toBe(200);
  });

  it("R2: mint_spacing_secs caps at 600 s and is service-role only", async () => {
    const { data } = await adminClient().rpc("mint_spacing_secs", { p_base_secs: 5, p_live_mints: 13 });
    expect(data).toBe(600);
    const { data: four } = await adminClient().rpc("mint_spacing_secs", { p_base_secs: 5, p_live_mints: 4 });
    expect(four).toBe(5);
    expect((await starter.db.rpc("mint_spacing_secs", { p_base_secs: 5, p_live_mints: 1 })).error).not.toBeNull();
  });

  it("429 mint_cap: at most 14 mints per meeting (ceil(4 h / 1 h) + 10); failed mints don't count", async () => {
    const id = await live(orgId, starter.id);
    const start = new Date(Date.now() - 3600 * 1000).toISOString();
    const unminted = Array.from({ length: 5 }, () => ({
      id: `bad-${randomUUID()}`,
      meeting_id: id,
      started_at: start,
      max_seconds: 1,
      closed_at: start,
      kind: "unminted",
    }));
    await adminClient().from("el_sessions").insert(unminted);
    const rows = Array.from({ length: 13 }, () => ({
      id: `old-${randomUUID()}`,
      meeting_id: id,
      started_at: start,
      max_seconds: 1,
      closed_at: start,
    }));
    await adminClient().from("el_sessions").insert(rows);
    as(starter);
    expect((await callToken(id)).status).toBe(200); // the 14th
    const { current_el_session_id } = await meetingRow(id);
    await age(id, current_el_session_id!, 30);
    const res = await callToken(id, { closingSessionId: current_el_session_id });
    expect(res.status).toBe(429);
    // Not the 5 s spacing: no retry can succeed, the page tells the user to start a new meeting.
    expect(await res.json()).toEqual({ error: "mint_cap" });
    expect(mint.fn).toHaveBeenCalledTimes(1);
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

  it("429 at the global daily hours cap (usage of other, even deleted, orgs counts)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    envOverride.GLOBAL_DAILY_HOURS = 60 / 3600;
    await withGlobalUsage({ seconds: 60 }, async () => {
      const res = await callToken(id);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "global_day" });
    });
  });

  it("429 at the global daily dollar cap (usage of other, even deleted, orgs counts)", async () => {
    const id = await live(orgId, starter.id);
    as(starter);
    envOverride.GLOBAL_DAILY_USD = 0.5;
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
      ["close_el_session", { p_session_id: "x", p_usd_per_hour: 0 }],
      [
        "claim_el_session",
        {
          p_meeting_id: randomUUID(),
          p_new_session_id: "x",
          p_closing_session_id: null,
          p_meeting_cap_secs: 1,
          p_org_month_cap_secs: 1,
          p_global_day_cap_secs: 1,
          p_global_usd_cap: 1,
          p_usd_per_hour: 0,
          p_max_mints: 1,
          p_min_mint_interval_secs: 1,
        },
      ],
      ["meeting_seconds", { p_meeting_id: randomUUID() }],
      ["release_unminted_el_session", { p_session_id: "x" }],
      ["global_day_seconds", {}],
    ] as const) {
      const { error } = await starter.db.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
  });
});
