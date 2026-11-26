import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// 0030: orgs.meeting_folder_name and meeting_doc_shares, and the "Få åtkomst" route as a real
// signed-in user (RLS decides). Google is faked: no Drive call leaves the test.

const current = vi.hoisted(() => ({ db: null as SupabaseClient | null, perm: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));
// The service role is the local stack's.
vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: async () => ({}),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: () => ({ permissions: { create: async (a: unknown) => (current.perm.push(a), { data: {} }) } }),
}));

const { POST } = await import("@/app/api/meetings/[id]/doc-access/route");
const askFor = (user: TestUser, id: string) => {
  current.db = user.db;
  return POST(new NextRequest(`https://x.test/api/meetings/${id}/doc-access`, { method: "POST" }), { params: Promise.resolve({ id }) });
};

describe.skipIf(!hasLocalSupabase)("Docs in the förening (0030)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let meetingId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([createTestUser("dsadmin"), createTestUser("dsmember"), createTestUser("dsoutsider")]);
    const r = await createOrg(admin.db, "Delningsföreningen");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
    ({ meetingId } = await seedMeeting(orgId, admin.id));
  });

  it("an admin can store the meeting folder's name, a member cannot", async () => {
    const ok = await admin.db.from("orgs").update({ meeting_folder_name: "Verksamhetsår 2026" }).eq("id", orgId).select("id");
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
    const no = await member.db.from("orgs").update({ meeting_folder_name: "Annat" }).eq("id", orgId).select("id");
    expect(no.data ?? []).toHaveLength(0);
    const { data } = await member.db.from("orgs").select("meeting_folder_name").eq("id", orgId).single();
    expect(data!.meeting_folder_name).toBe("Verksamhetsår 2026");
  });

  it("members read only their own share rows and cannot write them", async () => {
    expect((await adminClient().from("meeting_doc_shares").insert({ meeting_id: meetingId, user_id: admin.id })).error).toBeNull();
    const mine = await member.db.from("meeting_doc_shares").select("meeting_id").eq("meeting_id", meetingId);
    expect(mine.data).toEqual([]);
    const write = await member.db.from("meeting_doc_shares").insert({ meeting_id: meetingId, user_id: member.id });
    expect(write.error).not.toBeNull();
  });

  it("Få åtkomst: shares with the member's own address through the starter and records it; an outsider gets 404", async () => {
    const res = await askFor(member, meetingId);
    expect(res.status).toBe(204);
    expect(current.perm).toHaveLength(1);
    expect(current.perm[0]).toMatchObject({ fileId: "doc", requestBody: { role: "writer", emailAddress: member.email } });
    const rows = await member.db.from("meeting_doc_shares").select("meeting_id").eq("meeting_id", meetingId);
    expect(rows.data).toEqual([{ meeting_id: meetingId }]);

    expect((await askFor(outsider, meetingId)).status).toBe(404);
    expect(current.perm).toHaveLength(1);
  });

  it("the förening's own agenda Doc: 409 ask, no Drive call; at most 3 presses per hour, then 429", async () => {
    const { meetingId: agenda } = await seedMeeting(orgId, admin.id);
    await adminClient().from("meetings").update({ agenda_doc: true, app_created_doc: false }).eq("id", agenda);
    const res = await askFor(member, agenda);
    expect([res.status, (await res.json()).error]).toEqual([409, "not_ours"]);
    expect(current.perm).toHaveLength(1);

    const { meetingId: ours } = await seedMeeting(orgId, admin.id);
    for (let i = 0; i < 3; i++) expect((await askFor(member, ours)).status).toBe(204);
    expect((await askFor(member, ours)).status).toBe(429);
    expect(current.perm).toHaveLength(4);
  });

  it("a starter who left the förening is never used: 409 with a message to ask", async () => {
    const { meetingId: other } = await seedMeeting(orgId, member.id);
    await adminClient().from("org_members").delete().eq("org_id", orgId).eq("user_id", member.id);
    const third = await createTestUser("dsthird");
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    await joinOrg(third.db, data!.invite_code as string);
    const res = await askFor(third, other);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_starter");
    expect(current.perm).toHaveLength(1);
  });
});
