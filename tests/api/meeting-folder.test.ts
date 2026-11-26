import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// Against the local stack as real signed-in users, so RLS and the column grant decide.
const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

const { POST } = await import("@/app/api/orgs/[id]/meeting-folder/route");

const call = (orgId: string, body: unknown) =>
  POST(
    new NextRequest(`https://x.test/api/orgs/${orgId}/meeting-folder`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: orgId }) },
  );

const folderOf = async (orgId: string) =>
  (await adminClient().from("orgs").select("meeting_folder_id").eq("id", orgId).single()).data!.meeting_folder_id as string | null;

describe.skipIf(!hasLocalSupabase)("POST /api/orgs/[id]/meeting-folder", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("folder-admin"), createTestUser("folder-member")]);
    const r = await createOrg(admin.db, "Mappföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("admin sets the folder", async () => {
    current.db = admin.db;
    const res = await call(orgId, { folderId: "folderAAAA1111" });
    expect(res.status).toBe(204);
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
  });

  it("admin's pick stores the folder's name (trimmed); a pick without a name clears it", async () => {
    current.db = admin.db;
    const nameOf = async () => (await adminClient().from("orgs").select("meeting_folder_name").eq("id", orgId).single()).data!.meeting_folder_name;
    expect((await call(orgId, { folderId: "folderAAAA1111", folderName: "  Verksamhetsår   2026-2027 " })).status).toBe(204);
    expect(await nameOf()).toBe("Verksamhetsår 2026-2027");
    expect((await call(orgId, { folderId: "folderAAAA1111" })).status).toBe(204);
    expect(await nameOf()).toBeNull();
    // A member's grant-only pick never changes it.
    await call(orgId, { folderId: "folderAAAA1111", folderName: "Verksamhetsår 2026-2027" });
    current.db = member.db;
    expect((await call(orgId, { folderId: "folderAAAA1111", folderName: "Annat namn" })).status).toBe(204);
    expect(await nameOf()).toBe("Verksamhetsår 2026-2027");
  });

  it("member with the same id → 204, nothing changes", async () => {
    current.db = member.db;
    const res = await call(orgId, { folderId: "folderAAAA1111" });
    expect(res.status).toBe(204);
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
  });

  it("member with another id → 403, nothing changes", async () => {
    current.db = member.db;
    const res = await call(orgId, { folderId: "folderBBBB2222" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_meeting_folder");
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
  });

  it("grantOnly: an admin with another id → 403 and the folder is unchanged; the same id → 204", async () => {
    current.db = admin.db;
    const res = await call(orgId, { folderId: "folderCCCC3333", grantOnly: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_meeting_folder");
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
    expect((await call(orgId, { folderId: "folderAAAA1111", grantOnly: true })).status).toBe(204);
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
  });

  it("rejects a malformed folder id", async () => {
    current.db = admin.db;
    expect((await call(orgId, { folderId: "x' or '1'='1" })).status).toBe(400);
    expect(await folderOf(orgId)).toBe("folderAAAA1111");
  });
});
