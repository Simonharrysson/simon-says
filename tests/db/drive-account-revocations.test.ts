import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// 0070: a deleted account's share on a Doc the förening's Drive account made is queued in every
// förening, also when the deleted account is the meeting's starter, and revoked through that
// account. While the account is lost it waits (flagged, counted for admins); a renew removes it.
// Google is faked.

const g = vi.hoisted(() => ({ deleted: [] as { who: string; fileId: string; permissionId: string }[] }));
vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/crypto", () => ({ decrypt: (b: string) => b, encrypt: (b: string) => b }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: async (userId: string) => ({ who: `user:${userId}` }),
  clientForRefreshToken: async (label: string) => ({ who: label }),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: (auth: { who: string }) => ({
    permissions: { delete: async (a: { fileId: string; permissionId: string }) => (g.deleted.push({ who: auth.who, ...a }), {}) },
  }),
}));

const { blockedRevocationCount, drainForetagQueues } = await import("@/lib/foretag/reconcile");

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("revoking shares on the förening account's Docs (0070)", () => {
  let admin: TestUser;
  let orgId: string;
  const SUB = `sub-${crypto.randomUUID()}`;

  beforeAll(async () => {
    admin = await createTestUser("dar-adm");
    const r = await createOrg(admin.db, "Revokeföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    must("account", await adminClient().from("org_drive_accounts").insert({ org_id: orgId, connected_by: admin.id, google_sub: SUB, google_email: "styrelsen@ekdala.test", refresh_token_enc: "rt", scope: "drive.file", lost_at: new Date().toISOString() }));
  });

  /** A meeting whose Doc the förening's account made, started by `starter`, shared with `member`. */
  async function orgDoc(starter: TestUser, member: TestUser, permissionId: string): Promise<string> {
    const docId = `doc-${crypto.randomUUID()}`;
    const m = must("m", await adminClient().from("meetings").insert({ org_id: orgId, started_by: starter.id, doc_id: docId, notes_tab_id: "t.0", status: "done", drive_account_sub: SUB }).select("id").single()) as { id: string };
    must("share", await adminClient().from("meeting_doc_shares").insert({ meeting_id: m.id, user_id: member.id, email: member.email, permission_id: permissionId }));
    return docId;
  }
  const queued = async (docId: string) =>
    must("q", await adminClient().from("doc_share_revocations").select("owner_user_id, permission_id, org_id, drive_account_sub, blocked_at").eq("doc_id", docId));

  it("queued in a förening without groups, and when the starter themselves deletes their account", async () => {
    const member = await createTestUser("dar-mem");
    const docA = await orgDoc(admin, member, "perm-member");
    const starter = await createTestUser("dar-start");
    const docB = await orgDoc(starter, starter, "perm-starter");
    expect((await adminClient().auth.admin.deleteUser(member.id)).error).toBeNull();
    expect((await adminClient().auth.admin.deleteUser(starter.id)).error).toBeNull();
    expect(await queued(docA)).toEqual([{ owner_user_id: null, permission_id: "perm-member", org_id: orgId, drive_account_sub: SUB, blocked_at: null }]);
    expect(await queued(docB)).toEqual([{ owner_user_id: null, permission_id: "perm-starter", org_id: orgId, drive_account_sub: SUB, blocked_at: null }]);
  });

  it("the account lost: kept and flagged (never dropped, never another grant); renewed: revoked through it", async () => {
    g.deleted = [];
    await drainForetagQueues();
    expect(g.deleted).toEqual([]);
    const rows = must("rows", await adminClient().from("doc_share_revocations").select("blocked_at").eq("org_id", orgId)) ?? [];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.blocked_at)).toBe(true);
    expect(await blockedRevocationCount(orgId)).toBe(2);
    // A second run keeps them too.
    await drainForetagQueues();
    expect(await blockedRevocationCount(orgId)).toBe(2);

    must("renew", await adminClient().from("org_drive_accounts").update({ lost_at: null }).eq("org_id", orgId));
    await drainForetagQueues();
    expect(g.deleted.map((d) => [d.who, d.permissionId]).sort()).toEqual([
      [`org:${orgId}`, "perm-member"],
      [`org:${orgId}`, "perm-starter"],
    ]);
    expect(await blockedRevocationCount(orgId)).toBe(0);
    expect(must("left", await adminClient().from("doc_share_revocations").select("id").eq("org_id", orgId))).toEqual([]);
  });

  it("disconnected for good: kept and counted for the admins", async () => {
    const member = await createTestUser("dar-mem2");
    const doc = await orgDoc(admin, member, "perm-later");
    must("disconnect", await adminClient().from("org_drive_accounts").delete().eq("org_id", orgId));
    expect((await adminClient().auth.admin.deleteUser(member.id)).error).toBeNull();
    g.deleted = [];
    await drainForetagQueues();
    expect(g.deleted).toEqual([]);
    expect(await queued(doc)).toHaveLength(1);
    expect(await blockedRevocationCount(orgId)).toBe(1);
    must("cleanup", await adminClient().from("doc_share_revocations").delete().eq("org_id", orgId));
  });
});
