import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, deleteOrg, joinOrg, leaveOrg, removeMember, setMemberRole } from "@/lib/db/orgs";

// 0070 org_drive_accounts: the förening's own Drive account. Service role only (the refresh token
// never reaches a client), gone with the förening, and with its connecting admin's admin role.

const isDenied = (error: { message: string } | null) => Boolean(error && /permission denied/i.test(error.message));

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

async function orgWith(admin: TestUser, name: string, ...members: TestUser[]): Promise<string> {
  const r = await createOrg(admin.db, name);
  if (!r.ok) throw new Error("org");
  const code = await inviteCode(r.id);
  for (const m of members) expect(await joinOrg(m.db, code)).toBe(r.id);
  return r.id;
}

async function connect(orgId: string, by: string): Promise<void> {
  const { error } = await adminClient()
    .from("org_drive_accounts")
    .upsert({ org_id: orgId, connected_by: by, google_sub: `sub-${orgId}`, google_email: "styrelsen@ekdala.test", refresh_token_enc: "v1:secret", scope: "drive.file" });
  if (error) throw new Error(`connect: ${error.message}`);
}

const connected = async (orgId: string) =>
  (await adminClient().from("org_drive_accounts").select("org_id", { count: "exact", head: true }).eq("org_id", orgId)).count ?? 0;

describe.skipIf(!hasLocalSupabase)("org_drive_accounts (0070)", () => {
  let admin: TestUser;
  let second: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, second, member] = await Promise.all([createTestUser("da-adm"), createTestUser("da-adm2"), createTestUser("da-mem")]);
    orgId = await orgWith(admin, "Driveföreningen", second, member);
    expect(await setMemberRole(admin.db, orgId, second.id, "admin")).toBe("ok");
  });

  it("RLS: no client can read or write it, not even the förening's admin; the service role can", async () => {
    await connect(orgId, admin.id);
    for (const db of [anonClient(), admin.db, member.db]) {
      const read = await db.from("org_drive_accounts").select("*");
      expect(isDenied(read.error), "select").toBe(true);
      const write = await db.from("org_drive_accounts").insert({ org_id: orgId, connected_by: admin.id, google_sub: "x", google_email: "x@y.se", refresh_token_enc: "x", scope: "x" });
      expect(isDenied(write.error), "insert").toBe(true);
      const del = await db.from("org_drive_accounts").delete().eq("org_id", orgId);
      expect(isDenied(del.error), "delete").toBe(true);
    }
    expect(await connected(orgId)).toBe(1);
  });

  it("members cannot set which account made a meeting's Doc (no write grant on meetings / prepared_agendas)", async () => {
    const { meetingId } = await seedMeeting(orgId, member.id);
    const { data, error } = await member.db.from("meetings").update({ drive_account_sub: "sub-evil" }).eq("id", meetingId).select("id");
    expect(Boolean(error) || (data ?? []).length === 0).toBe(true);
    const { data: row } = await adminClient().from("meetings").select("drive_account_sub").eq("id", meetingId).single();
    expect(row?.drive_account_sub).toBeNull();
  });

  it("another admin stepping down leaves it; the connecting admin stepping down removes it", async () => {
    await connect(orgId, admin.id);
    expect(await setMemberRole(admin.db, orgId, second.id, "member")).toBe("ok");
    expect(await connected(orgId)).toBe(1);
    expect(await setMemberRole(admin.db, orgId, second.id, "admin")).toBe("ok");
    expect(await setMemberRole(second.db, orgId, admin.id, "member")).toBe("ok");
    expect(await connected(orgId)).toBe(0);
    expect(await setMemberRole(second.db, orgId, admin.id, "admin")).toBe("ok");
  });

  it("the connecting admin removed or leaving: removed", async () => {
    await connect(orgId, second.id);
    expect(await removeMember(admin.db, orgId, second.id)).toBe("removed");
    expect(await connected(orgId)).toBe(0);

    const third = await createTestUser("da-adm3");
    expect(await joinOrg(third.db, await inviteCode(orgId))).toBe(orgId);
    expect(await setMemberRole(admin.db, orgId, third.id, "admin")).toBe("ok");
    await connect(orgId, third.id);
    expect(await leaveOrg(third.db, orgId)).toBe("removed");
    expect(await connected(orgId)).toBe(0);
  });

  it("the förening deleted: removed", async () => {
    const owner = await createTestUser("da-del");
    const other = await orgWith(owner, "Raderas snart");
    await connect(other, owner.id);
    expect(await deleteOrg(owner.db, other, "Raderas snart")).toBe("deleted");
    expect(await connected(other)).toBe(0);
  });

  it("the connecting user's account deleted: removed", async () => {
    const gone = await createTestUser("da-gone");
    const other = await orgWith(await createTestUser("da-own"), "Kontot raderas");
    await connect(other, gone.id);
    await adminClient().auth.admin.deleteUser(gone.id);
    expect(await connected(other)).toBe(0);
  });
});
