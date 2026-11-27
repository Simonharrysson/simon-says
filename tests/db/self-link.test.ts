import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { addPerson, addSelfPerson, claimPerson, createOrg, isLinkedIn, joinOrg, renamePerson } from "@/lib/db/orgs";
import { ensurePrivatSpace } from "@/lib/privat/space";

// "Vem av dessa är du?" (migration 0051): claim_person, add_self_person and the guard that only an
// admin links a person to an account through the table. Fictional data.

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

async function person(orgId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient().from("people").insert({ org_id: orgId, name, ...extra }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function linkOf(id: string): Promise<string | null> {
  const { data } = await adminClient().from("people").select("member_user_id").eq("id", id).single();
  return (data?.member_user_id as string | null) ?? null;
}

describe.skipIf(!hasLocalSupabase)("self link (0051)", () => {
  let admin: TestUser;
  let member: TestUser;
  let second: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, second, outsider] = await Promise.all([
      createTestUser("sl-adm"),
      createTestUser("sl-mem"),
      createTestUser("sl-two"),
      createTestUser("sl-out"),
    ]);
    const r = await createOrg(admin.db, "Vem-är-du-föreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const code = await inviteCode(orgId);
    expect(await joinOrg(member.db, code)).toBe(orgId);
    expect(await joinOrg(second.db, code)).toBe(orgId);
  });

  describe("guard: only an admin links through the table", () => {
    it("a member can't link a person, to themselves or anyone", async () => {
      const p = await person(orgId, "Guard Gunnarsson");
      const { error } = await member.db.from("people").update({ member_user_id: member.id }).eq("id", p);
      expect(error?.code).toBe("42501");
      expect(await linkOf(p)).toBeNull();
    });

    it("a member can't unlink or re-link someone else's person", async () => {
      const p = await person(orgId, "Länkad Larsson", { member_user_id: second.id });
      expect((await member.db.from("people").update({ member_user_id: null }).eq("id", p)).error?.code).toBe("42501");
      expect((await member.db.from("people").update({ member_user_id: member.id }).eq("id", p)).error?.code).toBe("42501");
      expect(await linkOf(p)).toBe(second.id);
      await adminClient().from("people").update({ member_user_id: null }).eq("id", p);
    });

    it("a member can't insert a linked person", async () => {
      const { error } = await member.db.from("people").insert({ org_id: orgId, name: "Insatt Isaksson", member_user_id: member.id });
      expect(error?.code).toBe("42501");
    });

    it("a member still adds and renames people (no link involved)", async () => {
      expect(await addPerson(member.db, orgId, "Vanlig Vilhelmsson")).toBe(true);
      const { data } = await adminClient().from("people").select("id").eq("org_id", orgId).eq("name", "Vanlig Vilhelmsson").single();
      expect(await renamePerson(member.db, data!.id as string, "Vanlig Vilhelmsdotter")).toBe(true);
    });

    it("an admin still links and unlinks through the table", async () => {
      const p = await person(orgId, "Admin Andersson");
      // (0002 RLS: the link target must be a member of the förening.)
      expect((await admin.db.from("people").update({ member_user_id: second.id }).eq("id", p)).error).toBeNull();
      expect(await linkOf(p)).toBe(second.id);
      expect((await admin.db.from("people").update({ member_user_id: null }).eq("id", p)).error).toBeNull();
      expect(await linkOf(p)).toBeNull();
    });

    it("the admin-side functions still link (add_board_person)", async () => {
      const { data } = await admin.db.rpc("add_board_person", { p_org_id: orgId, p_name: "Styrelse Svensson", p_role: "", p_email: "", p_member_user_id: second.id });
      expect(data).toMatchObject({ result: "ok" });
      expect(await linkOf(data.id as string)).toBe(second.id);
      // Hand the link back so second can claim below.
      await adminClient().from("people").update({ member_user_id: null }).eq("id", data.id);
    });
  });

  describe("claim_person", () => {
    it("links the member to a free person, once per förening", async () => {
      const anna = await person(orgId, "Anna Claim");
      const bertil = await person(orgId, "Bertil Claim");
      expect(await isLinkedIn(member.db, orgId, member.id)).toBe(false);
      expect(await claimPerson(member.db, anna)).toBe("ok");
      expect(await linkOf(anna)).toBe(member.id);
      expect(await isLinkedIn(member.db, orgId, member.id)).toBe(true);
      // Again: still ok. Another person: already linked here.
      expect(await claimPerson(member.db, anna)).toBe("ok");
      expect(await claimPerson(member.db, bertil)).toBe("already");
      expect(await linkOf(bertil)).toBeNull();
      // Someone else on the same person: taken.
      expect(await claimPerson(second.db, anna)).toBe("taken");
    });

    it("refuses a person with someone else's invite address, allows one with your own", async () => {
      const invited = await person(orgId, "Inbjuden Ivarsson", { email: "nagon-annan@test.local" });
      expect(await claimPerson(second.db, invited)).toBe("taken");
      expect(await linkOf(invited)).toBeNull();
      const own = await person(orgId, "Egen Adress", { email: second.email.toUpperCase() });
      expect(await claimPerson(second.db, own)).toBe("ok");
      expect(await linkOf(own)).toBe(second.id);
      await adminClient().from("people").update({ member_user_id: null }).eq("id", own);
    });

    it("forbidden: a non-member, an unknown person, the Privat space", async () => {
      const p = await person(orgId, "Utanför Udd");
      expect(await claimPerson(outsider.db, p)).toBe("forbidden");
      expect(await claimPerson(member.db, "00000000-0000-4000-8000-000000000000")).toBe("forbidden");
      const space = await ensurePrivatSpace(outsider.db);
      const mine = await person(space, "Privat Person");
      expect(await claimPerson(outsider.db, mine)).toBe("forbidden");
      expect(await linkOf(p)).toBeNull();
    });
  });

  describe("add_self_person", () => {
    let org2: string;
    let newcomer: TestUser;
    let other: TestUser;

    beforeAll(async () => {
      [newcomer, other] = await Promise.all([createTestUser("sl-new"), createTestUser("sl-oth")]);
      const r = await createOrg(admin.db, "Lägg-till-föreningen");
      if (!r.ok) throw new Error("org");
      org2 = r.id;
      const code = await inviteCode(org2);
      await joinOrg(newcomer.db, code);
      await joinOrg(other.db, code);
    });

    it("adds the member, linked, with a role", async () => {
      expect(await addSelfPerson(newcomer.db, org2, "Ny Nilsson", "Kassör")).toBe("ok");
      const { data } = await adminClient().from("people").select("name, role, member_user_id").eq("org_id", org2).eq("name", "Ny Nilsson").single();
      expect(data).toEqual({ name: "Ny Nilsson", role: "Kassör", member_user_id: newcomer.id });
      // A second self: already.
      expect(await addSelfPerson(newcomer.db, org2, "Ny Andra", null)).toBe("already");
    });

    it("an existing free name is claimed; a taken one is refused", async () => {
      const free = await person(org2, "Fri Fransson");
      expect(await addSelfPerson(other.db, org2, "fri fransson ", null)).toBe("ok");
      expect(await linkOf(free)).toBe(other.id);
      const third = await createTestUser("sl-3rd");
      await joinOrg(third.db, await inviteCode(org2));
      expect(await addSelfPerson(third.db, org2, "Ny Nilsson", null)).toBe("taken");
    });

    it("forbidden for a non-member; invalid for an empty name", async () => {
      expect(await addSelfPerson(outsider.db, org2, "Ute Ulf", null)).toBe("forbidden");
      const fourth = await createTestUser("sl-4th");
      await joinOrg(fourth.db, await inviteCode(org2));
      expect(await addSelfPerson(fourth.db, org2, "   ", null)).toBe("invalid");
    });
  });
});
