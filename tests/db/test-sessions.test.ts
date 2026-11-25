import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createOrg } from "@/lib/db/orgs";
import { adminClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";

// Task T (migration 0011): a test session (kind 'test') never counts toward ElevenLabs hours or
// dollars, nor as a reservation, and closing it books nothing.

describe.skipIf(!hasLocalSupabase)("test sessions (el_sessions.kind)", () => {
  let orgId: string;
  let userId: string;

  /** A fresh org (own user: orgs per user are limited), so other tests' open sessions never count against it. */
  async function newOrg(): Promise<string> {
    const u = await createTestUser("t");
    userId = u.id;
    const r = await createOrg(u.db, `Testmöte-${randomUUID().slice(0, 8)}`);
    if (!r.ok) throw new Error("org");
    return r.id;
  }

  async function meeting(): Promise<string> {
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({
        org_id: orgId,
        started_by: userId,
        doc_id: "doc",
        notes_tab_id: "t.notes",
        status: "live",
        consent_confirmed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function session(meetingId: string, kind?: "live" | "test", maxSeconds = 900): Promise<string> {
    const id = `${kind ?? "live"}-${randomUUID()}`;
    const { error } = await adminClient()
      .from("el_sessions")
      .insert({ id, meeting_id: meetingId, max_seconds: maxSeconds, ...(kind ? { kind } : {}) });
    if (error) throw new Error(error.message);
    return id;
  }

  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    const { data, error } = await adminClient().rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  beforeAll(async () => {
    orgId = await newOrg();
  });

  it("kind defaults to 'live' and only accepts live/test", async () => {
    const m = await meeting();
    const id = await session(m);
    const { data } = await adminClient().from("el_sessions").select("kind").eq("id", id).single();
    expect(data?.kind).toBe("live");
    const { error } = await adminClient()
      .from("el_sessions")
      .insert({ id: `x-${randomUUID()}`, meeting_id: m, max_seconds: 10, kind: "other" });
    expect(error).not.toBeNull();
  });

  it("an open test session adds nothing to meeting, org-month or global-day seconds", async () => {
    const solo = await newOrg();
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({ org_id: solo, started_by: userId, doc_id: "doc", notes_tab_id: "t.notes", status: "live" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const m = data.id as string;
    await session(m, "test");
    expect(Number(await rpc("meeting_seconds", { p_meeting_id: m }))).toBe(0);
    expect(Number(await rpc("org_month_seconds", { p_org_id: solo }))).toBe(0);
    // meeting_seconds for a live session closes at ceil(elapsed) >= 1 s: the 0 above is the kind, not the clock.
    await session(m, "live", 900);
    expect(Number(await rpc("meeting_seconds", { p_meeting_id: m }))).toBeGreaterThanOrEqual(1);
  });

  it("closing a test session books 0 seconds and $0; closing a live one books both", async () => {
    const m = await meeting();
    const t = await session(m, "test");
    const day = new Date().toISOString().slice(0, 10);
    const usage = async () => {
      const { data } = await adminClient().from("usage_daily").select("seconds, usd").eq("org_id", orgId).eq("day", day);
      return (data ?? []).reduce((a, r) => ({ s: a.s + Number(r.seconds), usd: a.usd + Number(r.usd) }), { s: 0, usd: 0 });
    };
    const before = await usage();
    expect(Number(await rpc("close_el_session", { p_session_id: t, p_usd_per_hour: 5 }))).toBe(0);
    expect(await usage()).toEqual(before);
    const { data } = await adminClient().from("el_sessions").select("closed_at").eq("id", t).single();
    expect(data?.closed_at).not.toBeNull(); // closed, just not booked

    const l = await session(await meeting(), "live", 600);
    await rpc("close_el_session", { p_session_id: l, p_usd_per_hour: 5 });
    const after = await usage();
    expect(after.s).toBeGreaterThanOrEqual(before.s);
  });

  it("claim_el_session does not reserve an open test session's time", async () => {
    const solo = await newOrg();
    const mk = async () => {
      const { data, error } = await adminClient()
        .from("meetings")
        .insert({ org_id: solo, started_by: userId, doc_id: "doc", notes_tab_id: "t.notes", status: "live", consent_confirmed_at: new Date().toISOString() })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data.id as string;
    };
    await session(await mk(), "test", 2000); // would reserve 2000 s if it counted
    const target = await mk();
    const claim = async () =>
      (await rpc("claim_el_session", {
        p_meeting_id: target,
        p_new_session_id: `live-${randomUUID()}`,
        p_closing_session_id: null,
        p_meeting_cap_secs: 100_000,
        p_org_month_cap_secs: 3000,
        p_global_day_cap_secs: 1_000_000_000,
        p_global_usd_cap: 1_000_000_000,
        p_usd_per_hour: 0.22,
        p_max_mints: 30,
        p_min_mint_interval_secs: 0,
      })) as { status: string; max_seconds: number | null }[];
    const [row] = await claim();
    expect(row.status).toBe("ok");
    expect(row.max_seconds).toBe(3000);
  });
});
