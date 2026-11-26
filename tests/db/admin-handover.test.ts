import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg, leaveOrg, removeMember, setMemberRole } from "@/lib/db/orgs";

// Todo #8 / audit B3 (migration 0031): admins hand the förening over, and the DB keeps at least
// one admin on every write path (set_member_role + the keep_org_admin trigger).

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

async function roles(orgId: string): Promise<Record<string, string>> {
  const { data } = await adminClient().from("org_members").select("user_id, role").eq("org_id", orgId);
  return Object.fromEntries((data ?? []).map((r) => [r.user_id as string, r.role as string]));
}

/** An org created by `admin` with the given users joined as members. */
async function orgWith(admin: TestUser, name: string, ...members: TestUser[]): Promise<string> {
  const r = await createOrg(admin.db, name);
  if (!r.ok) throw new Error("org");
  const code = await inviteCode(r.id);
  for (const m of members) expect(await joinOrg(m.db, code)).toBe(r.id);
  return r.id;
}

describe.skipIf(!hasLocalSupabase)("admin handover: set_member_role", () => {
  let admin: TestUser;
  let member: TestUser;
  let other: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, other] = await Promise.all([createTestUser("ho-adm"), createTestUser("ho-mem"), createTestUser("ho-oth")]);
    orgId = await orgWith(admin, "Överlämningsföreningen", member, other);
  });

  it("a member cannot change roles", async () => {
    expect(await setMemberRole(member.db, orgId, member.id, "admin")).toBe("forbidden");
    expect(await setMemberRole(member.db, orgId, admin.id, "member")).toBe("forbidden");
    expect((await roles(orgId))[member.id]).toBe("member");
  });

  it("the last admin cannot demote themselves", async () => {
    expect(await setMemberRole(admin.db, orgId, admin.id, "member")).toBe("last_admin");
    expect((await roles(orgId))[admin.id]).toBe("admin");
  });

  it("an admin makes a member admin, who can then hand back and step down", async () => {
    expect(await setMemberRole(admin.db, orgId, member.id, "admin")).toBe("ok");
    expect(await setMemberRole(admin.db, orgId, member.id, "admin")).toBe("unchanged");
    // The new admin takes admin away from the old one, then the old one is just a member.
    expect(await setMemberRole(member.db, orgId, admin.id, "member")).toBe("ok");
    expect(await roles(orgId)).toMatchObject({ [admin.id]: "member", [member.id]: "admin" });
    expect(await setMemberRole(admin.db, orgId, admin.id, "admin")).toBe("forbidden");
    // The old admin can now leave; the new one is the last admin and can't.
    expect(await leaveOrg(admin.db, orgId)).toBe("removed");
    expect(await leaveOrg(member.db, orgId)).toBe("last_admin");
  });

  it("refuses unknown members and roles", async () => {
    expect(await setMemberRole(member.db, orgId, admin.id, "admin")).toBe("not_member");
    const { data } = await member.db.rpc("set_member_role", { p_org_id: orgId, p_user_id: other.id, p_role: "owner" });
    expect(data).toBe("invalid");
  });

  it("anon cannot call it; users cannot call the trigger function", async () => {
    const { anonClient } = await import("@/test/local-supabase");
    const { error } = await anonClient().rpc("set_member_role", { p_org_id: orgId, p_user_id: other.id, p_role: "admin" });
    expect(error).not.toBeNull();
    const { error: trig } = await member.db.rpc("keep_org_admin");
    expect(trig).not.toBeNull();
  });
});

describe.skipIf(!hasLocalSupabase)("admin handover: the DB keeps an admin", () => {
  it("direct writes (service role) can't demote or delete the last admin", async () => {
    const [a, m] = await Promise.all([createTestUser("kp-adm"), createTestUser("kp-mem")]);
    const orgId = await orgWith(a, "Bakstoppet", m);
    const demote = await adminClient().from("org_members").update({ role: "member" }).eq("org_id", orgId).eq("user_id", a.id);
    expect(demote.error?.code).toBe("23514");
    const del = await adminClient().from("org_members").delete().eq("org_id", orgId).eq("user_id", a.id);
    expect(del.error?.code).toBe("23514");
    expect((await roles(orgId))[a.id]).toBe("admin");
    // The sole member of an org is its last admin too.
    const solo = await createTestUser("kp-solo");
    const soloOrg = await orgWith(solo, "Ensam");
    const del2 = await adminClient().from("org_members").delete().eq("org_id", soloOrg).eq("user_id", solo.id);
    expect(del2.error?.code).toBe("23514");
  });

  it("two admins demoting each other at once: exactly one succeeds", async () => {
    const [a, b] = await Promise.all([createTestUser("race-a"), createTestUser("race-b")]);
    const orgId = await orgWith(a, "Kapplöpningen", b);
    expect(await setMemberRole(a.db, orgId, b.id, "admin")).toBe("ok");
    const results = await Promise.all([setMemberRole(a.db, orgId, b.id, "member"), setMemberRole(b.db, orgId, a.id, "member")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(Object.values(await roles(orgId)).filter((r) => r === "admin")).toHaveLength(1);
  });

  it("two admins leaving at once: exactly one leaves", async () => {
    const [a, b] = await Promise.all([createTestUser("race-c"), createTestUser("race-d")]);
    const orgId = await orgWith(a, "Utgången", b);
    expect(await setMemberRole(a.db, orgId, b.id, "admin")).toBe("ok");
    const results = await Promise.all([leaveOrg(a.db, orgId), leaveOrg(b.db, orgId)]);
    expect(results.sort()).toEqual(["last_admin", "removed"]);
    expect(Object.values(await roles(orgId))).toEqual(["admin"]);
  });

  it("an admin removing the other admin while that one demotes them: one admin is left", async () => {
    const [a, b] = await Promise.all([createTestUser("race-e"), createTestUser("race-f")]);
    const orgId = await orgWith(a, "Korsdraget", b);
    expect(await setMemberRole(a.db, orgId, b.id, "admin")).toBe("ok");
    await Promise.all([removeMember(a.db, orgId, b.id), setMemberRole(b.db, orgId, a.id, "member")]);
    expect(Object.values(await roles(orgId)).filter((r) => r === "admin")).toHaveLength(1);
  });

  it("deleting the last admin's account hands the förening to the oldest member", async () => {
    const [a, first, second] = await Promise.all([createTestUser("del-adm"), createTestUser("del-1"), createTestUser("del-2")]);
    const orgId = await orgWith(a, "Arvet", first, second);
    const { error } = await adminClient().auth.admin.deleteUser(a.id);
    expect(error).toBeNull();
    expect(await roles(orgId)).toEqual({ [first.id]: "admin", [second.id]: "member" });
  });

  it("deleting the account of an org's only member still works; the next to join becomes admin", async () => {
    const solo = await createTestUser("del-solo");
    const orgId = await orgWith(solo, "Tomrummet");
    const code = await inviteCode(orgId);
    const { error } = await adminClient().auth.admin.deleteUser(solo.id);
    expect(error).toBeNull();
    expect(await roles(orgId)).toEqual({});
    const [next, after] = await Promise.all([createTestUser("del-next"), createTestUser("del-after")]);
    expect(await joinOrg(next.db, code)).toBe(orgId);
    expect(await joinOrg(after.db, code)).toBe(orgId);
    expect(await roles(orgId)).toEqual({ [next.id]: "admin", [after.id]: "member" });
  });

  it("two direct demotes at once (service role, trigger only): exactly one succeeds", async () => {
    const [a, b] = await Promise.all([createTestUser("trig-a"), createTestUser("trig-b")]);
    const orgId = await orgWith(a, "Utlösaren", b);
    expect(await setMemberRole(a.db, orgId, b.id, "admin")).toBe("ok");
    const demote = (id: string) =>
      adminClient().from("org_members").update({ role: "member" }).eq("org_id", orgId).eq("user_id", id);
    const results = await Promise.all([demote(a.id), demote(b.id)]);
    expect(results.map((r) => r.error?.code ?? "ok").sort()).toEqual(["23514", "ok"]);
    expect(Object.values(await roles(orgId)).filter((r) => r === "admin")).toHaveLength(1);
  });

  it("deleting a förening still removes all its members", async () => {
    const [a, m] = await Promise.all([createTestUser("org-del-a"), createTestUser("org-del-m")]);
    const orgId = await orgWith(a, "Nedläggningen", m);
    const { error } = await a.db.from("orgs").delete().eq("id", orgId);
    expect(error).toBeNull();
    expect(await roles(orgId)).toEqual({});
  });
});
