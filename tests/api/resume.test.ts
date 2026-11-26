// Task 7: "Fortsätt mötet" (abandoned < 2 h → live) and the Paus log. DB tests: CI only.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const base = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
  });
  return { ...mod, getEnv: () => base };
});

const { POST: postResume } = await import("@/app/api/meetings/[id]/resume/route");
const { POST: postPause } = await import("@/app/api/meetings/[id]/pause/route");
const { canResume } = await import("@/lib/meetings/resume");
const { endFromOrgPage } = await import("@/lib/meetings/end-from-org");

const call = (handler: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body?: unknown) =>
  handler(
    new NextRequest(`https://x.test/api/meetings/${id}/x`, {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("canResume", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  it("live always; abandoned only within 2 h; never done/ending", () => {
    expect(canResume({ status: "live", ended_at: null }, now)).toBe(true);
    expect(canResume({ status: "abandoned", ended_at: "2026-11-25T10:30:00Z" }, now)).toBe(true);
    expect(canResume({ status: "abandoned", ended_at: "2026-11-25T09:59:00Z" }, now)).toBe(false);
    expect(canResume({ status: "done", ended_at: "2026-11-25T11:59:00Z" }, now)).toBe(false);
    expect(canResume({ status: "ending", ended_at: "2026-11-25T11:59:00Z" }, now)).toBe(false);
  });
});

describe.skipIf(!hasLocalSupabase)("resume + pause routes", () => {
  let starter: TestUser;
  let member: TestUser;
  let orgId: string;
  const as = (u: TestUser | null) => {
    current.db = u ? u.db : anonClient();
  };

  beforeAll(async () => {
    [starter, member] = await Promise.all([createTestUser("resumer"), createTestUser("resume-member")]);
    const r = await createOrg(starter.db, "Resume-föreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data: invite } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    const { error } = await member.db.rpc("join_org", { p_code: invite!.invite_code });
    if (error) throw new Error(error.message);
  });

  async function meeting(status: string, endedAgoMin: number | null) {
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({
        org_id: orgId,
        started_by: starter.id,
        doc_id: "doc",
        notes_tab_id: "t",
        status,
        end_status: status === "abandoned" ? "abandoned" : null,
        consent_confirmed_at: new Date().toISOString(),
        started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        ended_at: endedAgoMin === null ? null : new Date(Date.now() - endedAgoMin * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }
  const row = async (id: string) =>
    (await adminClient().from("meetings").select("status, ended_at, end_status, last_heartbeat_at").eq("id", id).single()).data!;
  const clear = () => adminClient().from("meetings").delete().eq("org_id", orgId);

  it("abandoned 30 min ago → live again, end fields cleared, fresh heartbeat, event logged", async () => {
    await clear();
    const id = await meeting("abandoned", 30);
    as(starter);
    const res = await call(postResume, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "resumed" });
    const m = await row(id);
    expect(m).toMatchObject({ status: "live", ended_at: null, end_status: null });
    expect(Date.now() - Date.parse(m.last_heartbeat_at!)).toBeLessThan(60_000);
    const { data: ev } = await adminClient().from("meeting_events").select("kind").eq("meeting_id", id);
    expect(ev!.map((e) => e.kind)).toContain("resumed");
  });

  it("live → nothing to do; abandoned 3 h ago and done → 409", async () => {
    await clear();
    const live = await meeting("live", null);
    as(starter);
    expect(await (await call(postResume, live)).json()).toEqual({ result: "live" });
    await clear();
    const old = await meeting("abandoned", 180);
    expect((await call(postResume, old)).status).toBe(409);
    const done = await meeting("done", 5);
    expect((await call(postResume, done)).status).toBe(409);
    expect((await row(old)).status).toBe("abandoned");
  });

  it("refused while another meeting of the org runs; any member may resume, not signed out", async () => {
    await clear();
    const id = await meeting("abandoned", 10);
    await meeting("live", null);
    as(starter);
    expect(await (await call(postResume, id)).json()).toEqual({ error: "org_busy" });
    as(member);
    expect(await (await call(postResume, id)).json()).toEqual({ error: "org_busy" });
    as(null);
    expect((await call(postResume, id)).status).toBe(401);
  });

  it("org page Avsluta: a member who didn't start it is refused; an admin claims the end (live → ending)", async () => {
    await clear();
    const id = await meeting("live", null);
    expect(await endFromOrgPage(member.db, member.id, id)).toBe("forbidden");
    expect((await row(id)).status).toBe("live");
    // starter is the org's admin (createOrg)
    expect(await endFromOrgPage(starter.db, starter.id, id)).toBe("ending");
    expect((await row(id)).status).toBe("ending");
    expect((await row(id)).end_status).toBe("done");
    expect(await endFromOrgPage(starter.db, starter.id, id)).toBe("noop");
    await clear();
  });

  it("pause log: paused/unpaused events for a live meeting; 400 without a boolean", async () => {
    await clear();
    const id = await meeting("live", null);
    as(starter);
    expect((await call(postPause, id, { paused: true })).status).toBe(200);
    expect((await call(postPause, id, { paused: false })).status).toBe(200);
    expect((await call(postPause, id, {})).status).toBe(400);
    const { data: ev } = await adminClient().from("meeting_events").select("kind").eq("meeting_id", id).order("at");
    expect(ev!.map((e) => e.kind)).toEqual(["paused", "unpaused"]);
    // Whoever runs the meeting (any member) may pause it.
    as(member);
    expect((await call(postPause, id, { paused: true })).status).toBe(200);
    as(null);
    expect((await call(postPause, id, { paused: true })).status).toBe(401);
  });
});
