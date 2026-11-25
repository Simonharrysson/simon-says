import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg, leaveOrg, listMyOrgs, removeMember } from "@/lib/db/orgs";
import { orgMemberList } from "@/lib/db/members";
import { testEnv } from "@/test/env";

// Final fix wave A2 (migration 0018: remove_member / leave_org) and A3 (0019: segments are
// server-only).

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

describe.skipIf(!hasLocalSupabase)("members: remove and leave", () => {
  let admin: TestUser;
  let member: TestUser;
  let other: TestUser;
  let orgId: string;

  beforeAll(async () => {
    Object.assign(process.env, testEnv, {
      SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    });
    [admin, member, other] = await Promise.all([createTestUser("adm"), createTestUser("mem"), createTestUser("oth")]);
    const r = await createOrg(admin.db, "Medlemsföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const code = await inviteCode(orgId);
    expect(await joinOrg(member.db, code)).toBe(orgId);
    expect(await joinOrg(other.db, code)).toBe(orgId);
  });

  it("lists members with role and email (service role)", async () => {
    const list = await orgMemberList(orgId);
    expect(list.map((m) => m.userId)).toEqual([admin.id, member.id, other.id]);
    expect(list[0].role).toBe("admin");
    expect(list[1]).toMatchObject({ role: "member" });
    expect(list[1].email).toContain("@");
    const { error } = await member.db.rpc("org_member_list", { p_org_id: orgId });
    expect(error).not.toBeNull();
  });

  it("a non-admin cannot remove anyone", async () => {
    expect(await removeMember(member.db, orgId, other.id)).toBe("forbidden");
    expect((await orgMemberList(orgId)).length).toBe(3);
  });

  it("an admin removes a member: they lose the org, their people link is cleared, the person stays", async () => {
    const { data: person } = await adminClient()
      .from("people")
      .insert({ org_id: orgId, name: "Övrig Medlem", member_user_id: other.id })
      .select("id")
      .single();
    expect(await removeMember(admin.db, orgId, other.id)).toBe("removed");
    expect((await listMyOrgs(other.db)).map((o) => o.id)).not.toContain(orgId);
    const { data: meetings } = await other.db.from("meetings").select("id").eq("org_id", orgId);
    expect(meetings).toEqual([]);
    const { data: p } = await adminClient().from("people").select("member_user_id").eq("id", person!.id).single();
    expect(p!.member_user_id).toBeNull();
    expect(await removeMember(admin.db, orgId, other.id)).toBe("not_member");
  });

  it("the last admin can neither leave nor remove themselves; a member can leave", async () => {
    expect(await leaveOrg(admin.db, orgId)).toBe("last_admin");
    expect(await removeMember(admin.db, orgId, admin.id)).toBe("last_admin");
    expect(await leaveOrg(member.db, orgId)).toBe("removed");
    expect((await listMyOrgs(member.db)).map((o) => o.id)).not.toContain(orgId);
    expect(await leaveOrg(member.db, orgId)).toBe("not_member");
  });

  it("with two admins one may leave, then the other is the last", async () => {
    const u = await createTestUser("adm2");
    expect(await joinOrg(u.db, await inviteCode(orgId))).toBe(orgId);
    await adminClient().from("org_members").update({ role: "admin" }).eq("org_id", orgId).eq("user_id", u.id);
    expect(await leaveOrg(u.db, orgId)).toBe("removed");
    expect(await leaveOrg(admin.db, orgId)).toBe("last_admin");
  });

  it("the helper is not callable by users", async () => {
    const { error } = await admin.db.rpc("remove_org_member_locked", { p_org_id: orgId, p_user_id: member.id });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!hasLocalSupabase)("segments are server-only (A3)", () => {
  it("a member cannot read segments over the API, even with share_transcript on", async () => {
    const u = await createTestUser("seg");
    const r = await createOrg(u.db, "Transkriptföreningen");
    if (!r.ok) throw new Error("org");
    const { meetingId, sessionId } = await seedMeeting(r.id, u.id);
    const { error: se } = await adminClient().from("segments").insert({
      meeting_id: meetingId,
      el_session_id: sessionId,
      segment_index: 0,
      run_index: 0,
      speaker: "speaker_0",
      text: "Hemligt",
      start_ms: 0,
      end_ms: 1000,
    });
    expect(se).toBeNull();
    const { data, error } = await u.db.from("segments").select("text").eq("meeting_id", meetingId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

describe.skipIf(!hasLocalSupabase)("guard_meeting_start (0021, Ruling 39)", () => {
  const insertLive = async (orgId: string, userId: string, startedAt = new Date().toISOString()) => {
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({ org_id: orgId, started_by: userId, doc_id: "doc", notes_tab_id: "t", status: "live", started_at: startedAt })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  const guard = async (id: string) =>
    (await adminClient().rpc("guard_meeting_start", { p_meeting_id: id, p_max_per_hour: 6 })).data as string;
  const exists = async (id: string) => ((await adminClient().from("meetings").select("id").eq("id", id)).data ?? []).length > 0;

  it("two concurrent starts by one starter: exactly one survives", async () => {
    const u = await createTestUser("race");
    const r = await createOrg(u.db, "Racet");
    if (!r.ok) throw new Error("org");
    const [a, b] = await Promise.all([insertLive(r.id, u.id), insertLive(r.id, u.id)]);
    const results = await Promise.all([guard(a), guard(b)]);
    expect(results.sort()).toEqual(["ok", "starter_busy"]);
    expect([await exists(a), await exists(b)].filter(Boolean)).toHaveLength(1);
  });

  it("the 7th start within an hour is refused and removed", async () => {
    const u = await createTestUser("rate");
    const r = await createOrg(u.db, "Takten");
    if (!r.ok) throw new Error("org");
    const earlier = new Date(Date.now() - 600_000).toISOString();
    for (let i = 0; i < 6; i++) {
      const id = await insertLive(r.id, u.id, earlier);
      await adminClient().from("meetings").update({ status: "done" }).eq("id", id);
    }
    const seventh = await insertLive(r.id, u.id);
    expect(await guard(seventh)).toBe("start_rate");
    expect(await exists(seventh)).toBe(false);
  });

  it("is service-role only", async () => {
    const u = await createTestUser("guardrpc");
    const { error } = await u.db.rpc("guard_meeting_start", { p_meeting_id: crypto.randomUUID(), p_max_per_hour: 6 });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!hasLocalSupabase)("guard_meeting_start_v2 (0027, final review R2-I1)", () => {
  const insertLive = async (orgId: string, userId: string, docId: string) => {
    const { data, error } = await adminClient()
      .from("meetings")
      .insert({ org_id: orgId, started_by: userId, doc_id: docId, notes_tab_id: "t", status: "live", started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  const guard = async (id: string) =>
    (await adminClient().rpc("guard_meeting_start_v2", { p_meeting_id: id, p_max_per_hour: 6 })).data as string;
  const exists = async (id: string) => ((await adminClient().from("meetings").select("id").eq("id", id)).data ?? []).length > 0;

  it("two members starting on the same Doc at once: exactly one survives", async () => {
    const a = await createTestUser("v2a");
    const b = await createTestUser("v2b");
    const r = await createOrg(a.db, "Samma dokument");
    if (!r.ok) throw new Error("org");
    const doc = `doc-${crypto.randomUUID()}`;
    const [ma, mb] = await Promise.all([insertLive(r.id, a.id, doc), insertLive(r.id, b.id, doc)]);
    const results = await Promise.all([guard(ma), guard(mb)]);
    expect(results.sort()).toEqual(["ok", "org_busy"]);
    expect([await exists(ma), await exists(mb)].filter(Boolean)).toHaveLength(1);
  });

  it("another org's live meeting on the same Doc → doc_busy, the row removed", async () => {
    const a = await createTestUser("v2c");
    const b = await createTestUser("v2d");
    const ra = await createOrg(a.db, "Förening A");
    const rb = await createOrg(b.db, "Förening B");
    if (!ra.ok || !rb.ok) throw new Error("org");
    const doc = `doc-${crypto.randomUUID()}`;
    const first = await insertLive(ra.id, a.id, doc);
    expect(await guard(first)).toBe("ok");
    const second = await insertLive(rb.id, b.id, doc);
    expect(await guard(second)).toBe("doc_busy");
    expect(await exists(second)).toBe(false);
    expect(await exists(first)).toBe(true);
  });

  it("a done meeting on the Doc is no obstacle; the old guard still answers", async () => {
    const a = await createTestUser("v2e");
    const r = await createOrg(a.db, "Igen");
    if (!r.ok) throw new Error("org");
    const doc = `doc-${crypto.randomUUID()}`;
    const old = await insertLive(r.id, a.id, doc);
    await adminClient().from("meetings").update({ status: "done" }).eq("id", old);
    const next = await insertLive(r.id, a.id, doc);
    expect(await guard(next)).toBe("ok");
    expect((await adminClient().rpc("guard_meeting_start", { p_meeting_id: next, p_max_per_hour: 6 })).data).toBe("ok");
  });

  it("is service-role only", async () => {
    const u = await createTestUser("guardrpc2");
    const { error } = await u.db.rpc("guard_meeting_start_v2", { p_meeting_id: crypto.randomUUID(), p_max_per_hour: 6 });
    expect(error).not.toBeNull();
  });
});
