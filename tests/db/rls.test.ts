import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "@/test/env";
import {
  adminClient,
  anonClient,
  createTestUser,
  hasLocalSupabase,
  seedMeeting,
  type TestUser,
} from "@/test/local-supabase";
import { createOrg, joinOrg, inviteOrgName, listMyOrgs, myRole } from "@/lib/db/orgs";

// `segments` is not tested yet: the table waits for the Task 0 spike (Ruling 10).

const TABLES = [
  "orgs",
  "org_members",
  "people",
  "meetings",
  "el_sessions",
  "meeting_events",
  "speaker_map",
  "note_items",
  "usage_daily",
  "google_tokens",
] as const;

const MEETING_TABLES = ["el_sessions", "meeting_events", "speaker_map", "note_items"] as const;

const isPermissionDenied = (error: { message: string } | null) =>
  Boolean(error && /permission denied/i.test(error.message));

describe.skipIf(!hasLocalSupabase)("RLS and grants", () => {
  let a: TestUser;
  let b: TestUser;
  let orgA: string;
  let orgB: string;
  let meetingA: string;

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestUser("a"), createTestUser("b")]);
    const ra = await createOrg(a.db, "Org A");
    const rb = await createOrg(b.db, "Org B");
    if (!ra.ok || !rb.ok) throw new Error("org setup failed");
    orgA = ra.id;
    orgB = rb.id;
    ({ meetingId: meetingA } = await seedMeeting(orgA, a.id));
    await seedMeeting(orgB, b.id);
    const admin = adminClient();
    const day = new Date().toISOString().slice(0, 10);
    for (const org of [orgA, orgB]) {
      const { error } = await admin.from("usage_daily").insert({ org_id: org, day, seconds: 10 });
      if (error) throw error;
    }
    const { error } = await admin.from("people").insert({ org_id: orgB, name: "Bertil" });
    if (error) throw error;
  });

  it("anon has no access to any table", async () => {
    const anon = anonClient();
    for (const table of TABLES) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(isPermissionDenied(error), `anon select ${table}: ${error?.message}`).toBe(true);
    }
  });

  it("google_tokens is unreadable and unwritable by a signed-in user, even their own row", async () => {
    const { error: seedError } = await adminClient()
      .from("google_tokens")
      .insert({ user_id: a.id, refresh_token_enc: "enc", scope: "drive.file" });
    expect(seedError).toBeNull();
    const { error } = await a.db.from("google_tokens").select("*");
    expect(isPermissionDenied(error)).toBe(true);
    const { error: writeError } = await a.db
      .from("google_tokens")
      .upsert({ user_id: a.id, refresh_token_enc: "x", scope: "x" });
    expect(isPermissionDenied(writeError)).toBe(true);
  });

  it("the creator of an org is its admin", async () => {
    expect(await myRole(a.db, orgA)).toBe("admin");
    const orgs = await listMyOrgs(a.db);
    expect(orgs.map((o) => [o.name, o.role])).toEqual([["Org A", "admin"]]);
  });

  it("rejects a 3rd org by the same user", async () => {
    const user = await createTestUser("limit");
    expect((await createOrg(user.db, "Ett")).ok).toBe(true);
    expect((await createOrg(user.db, "Två")).ok).toBe(true);
    expect(await createOrg(user.db, "Tre")).toEqual({ ok: false, reason: "limit" });
    expect(await listMyOrgs(user.db)).toHaveLength(2);
  });

  it("cannot create an org in someone else's name", async () => {
    const { error } = await a.db.from("orgs").insert({ name: "Spoof", created_by: b.id });
    expect(error).not.toBeNull();
  });

  it("a member of org A cannot read org B's org, people, meetings or anything under them", async () => {
    const { data: orgs } = await a.db.from("orgs").select("id");
    expect(orgs?.map((o) => o.id)).toEqual([orgA]);

    const { data: people } = await a.db.from("people").select("org_id");
    expect(people?.every((p) => p.org_id === orgA)).toBe(true);

    for (const table of ["meetings", "usage_daily", "org_members"] as const) {
      const { data, error } = await a.db.from(table).select("org_id");
      expect(error).toBeNull();
      expect(data?.length, table).toBeGreaterThan(0);
      expect(data?.every((r) => r.org_id === orgA), table).toBe(true);
    }
    for (const table of MEETING_TABLES) {
      const { data, error } = await a.db.from(table).select("meeting_id");
      expect(error).toBeNull();
      expect(data?.map((r) => r.meeting_id), table).toEqual([meetingA]);
    }
  });

  it("clients cannot write meeting data, usage or memberships", async () => {
    const attempts = [
      a.db.from("note_items").insert({ meeting_id: meetingA, id: "x", section: "now", text: "x" }),
      a.db.from("meeting_events").insert({ meeting_id: meetingA, kind: "alarm" }),
      a.db.from("usage_daily").insert({ org_id: orgA, day: "2026-01-01" }),
      a.db.from("meetings").insert({ org_id: orgA, doc_id: "d", notes_tab_id: "t" }),
      a.db.from("org_members").insert({ org_id: orgB, user_id: a.id, role: "admin" }),
      a.db.from("orgs").update({ invite_code: "chosen" }).eq("id", orgA),
    ];
    for (const attempt of attempts) {
      const { error } = await attempt;
      expect(isPermissionDenied(error), error?.message).toBe(true);
    }
  });

  it("joins by invite code as a member and then sees the org's meetings", async () => {
    const joiner = await createTestUser("joiner");
    const { data: org } = await adminClient().from("orgs").select("invite_code").eq("id", orgA).single();
    const code = org!.invite_code as string;

    expect(await inviteOrgName(joiner.db, code)).toBe("Org A");
    expect(await inviteOrgName(joiner.db, "no-such-code")).toBeNull();
    expect(await joinOrg(joiner.db, "no-such-code")).toBeNull();

    const { data: before } = await joiner.db.from("meetings").select("id");
    expect(before).toEqual([]);

    expect(await joinOrg(joiner.db, code)).toBe(orgA);
    expect(await myRole(joiner.db, orgA)).toBe("member");
    const { data: after } = await joiner.db.from("meetings").select("id");
    expect(after?.map((m) => m.id)).toEqual([meetingA]);

    // A member is not an admin: no settings changes, no invite rotation.
    const { data: updated } = await joiner.db.from("orgs").update({ name: "Kapad" }).eq("id", orgA).select("id");
    expect(updated).toEqual([]);
    const { error: rotateError } = await joiner.db.rpc("rotate_invite_code", { p_org_id: orgA });
    expect(rotateError).not.toBeNull();
  });

  it("anon cannot join or look up invite codes", async () => {
    const anon = anonClient();
    expect(isPermissionDenied((await anon.rpc("join_org", { p_code: "x" })).error)).toBe(true);
    expect(isPermissionDenied((await anon.rpc("invite_org_name", { p_code: "x" })).error)).toBe(true);
  });

  it("server-only functions are not callable by signed-in users", async () => {
    expect(isPermissionDenied((await a.db.rpc("org_month_seconds", { p_org_id: orgA })).error)).toBe(true);
    expect(isPermissionDenied((await a.db.rpc("member_emails", { p_org_id: orgA })).error)).toBe(true);
  });

  describe("server helpers (service role)", () => {
    beforeAll(() => {
      Object.assign(process.env, testEnv, {
        SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
      });
    });

    it("orgMonthSeconds = this month's closed seconds + open sessions' capped elapsed time", async () => {
      const { orgMonthSeconds } = await import("@/lib/db/usage");
      const user = await createTestUser("usage");
      const r = await createOrg(user.db, "Usage");
      if (!r.ok) throw new Error("org");
      const admin = adminClient();
      const { meetingId } = await seedMeeting(r.id, user.id);
      const now = Date.now();
      const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
      const lastMonth = new Date(now - 40 * 86_400_000).toISOString().slice(0, 10);
      const today = new Date(now).toISOString().slice(0, 10);
      for (const { error } of [
        await admin.from("usage_daily").insert([
          { org_id: r.id, day: today, seconds: 100 },
          { org_id: r.id, day: lastMonth, seconds: 5000 },
        ]),
        // Seeded session (open, max 3600 s, started just now) → ~0 s. Replace with known ones:
        await admin.from("el_sessions").update({ closed_at: iso(0) }).eq("meeting_id", meetingId),
        await admin.from("el_sessions").insert([
          // open, started 10 min ago, capped at 300 s → 300
          { id: `cap-${r.id}`, meeting_id: meetingId, started_at: iso(600_000), max_seconds: 300 },
          // open, started 60 s ago, max 1 h → ~60
          { id: `run-${r.id}`, meeting_id: meetingId, started_at: iso(60_000), max_seconds: 3600 },
          // closed: counted via usage_daily only
          { id: `done-${r.id}`, meeting_id: meetingId, started_at: iso(900_000), max_seconds: 3600, closed_at: iso(800_000) },
        ]),
      ]) {
        expect(error).toBeNull();
      }
      const seconds = await orgMonthSeconds(r.id);
      expect(seconds).toBeGreaterThanOrEqual(100 + 300 + 59);
      expect(seconds).toBeLessThanOrEqual(100 + 300 + 70);
    });

    it("dayUsd sums today's usd across orgs", async () => {
      const { dayUsd } = await import("@/lib/db/usage");
      const before = await dayUsd();
      const user = await createTestUser("usd");
      const r = await createOrg(user.db, "Usd");
      if (!r.ok) throw new Error("org");
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await adminClient().from("usage_daily").insert({ org_id: r.id, day: today, usd: 1.25 });
      expect(error).toBeNull();
      expect(await dayUsd()).toBeCloseTo(before + 1.25, 6);
    });

    it("memberEmails lists the org's members", async () => {
      const { memberEmails } = await import("@/lib/db/members");
      expect(await memberEmails(orgB)).toEqual([b.email]);
    });

    it("logEvent appends to meeting_events", async () => {
      const { logEvent } = await import("@/lib/db/events");
      await logEvent(meetingA, "consent", { by: a.id });
      const { data } = await adminClient()
        .from("meeting_events")
        .select("kind, detail")
        .eq("meeting_id", meetingA)
        .eq("kind", "consent");
      expect(data).toEqual([{ kind: "consent", detail: { by: a.id } }]);
    });
  });
});
