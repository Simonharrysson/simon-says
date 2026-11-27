import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// POST /api/orgs/[id]/task-fields: the Avsluta dialog's "Fråga inte igen i den här föreningen"
// and its Ångra, against the local stack as real signed-in users. Fictional data only.
const m = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));

const route = (await import("@/app/api/orgs/[id]/task-fields/route")).POST;
const call = (orgId: string, body: unknown) =>
  route(
    new NextRequest(`https://x.test/api/orgs/${orgId}/task-fields`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ id: orgId }) },
  );
const asks = async (orgId: string) => (await adminClient().from("orgs").select("require_task_fields").eq("id", orgId).single()).data?.require_task_fields;
const events = async (meetingId: string) =>
  (await adminClient().from("meeting_events").select("detail").eq("meeting_id", meetingId).eq("kind", "task_setting").order("id")).data?.map((r) => r.detail);

describe.skipIf(!hasLocalSupabase)("task-fields route", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("tfadmin"), createTestUser("tfmember")]);
    const r = await createOrg(admin.db, "Schackklubben Löparen");
    const o = await createOrg(admin.db, "Bokcirkeln Sidan");
    if (!r.ok || !o.ok) throw new Error("org setup failed");
    orgId = r.id;
    otherOrgId = o.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("admin: off from the dialog, then Ångra; each logged with the meeting, counts only", async () => {
    m.db = admin.db;
    const { meetingId } = await seedMeeting(orgId, admin.id, "live");
    expect(await asks(orgId)).toBe(true);
    const off = await call(orgId, { on: false, meetingId });
    expect(off.status).toBe(200);
    expect(await asks(orgId)).toBe(false);
    expect((await call(orgId, { on: true, meetingId })).status).toBe(200);
    expect(await asks(orgId)).toBe(true);
    expect(await events(meetingId)).toEqual([
      { on: false, from: "end_dialog" },
      { on: true, from: "end_dialog" },
    ]);
  });

  it("a member can't turn it off (403, unchanged)", async () => {
    m.db = member.db;
    expect((await call(orgId, { on: false })).status).toBe(403);
    expect(await asks(orgId)).toBe(true);
  });

  it("bad input → 400; a meeting of another förening is not logged", async () => {
    m.db = admin.db;
    expect((await call(orgId, { on: "no" })).status).toBe(400);
    const { meetingId } = await seedMeeting(otherOrgId, admin.id, "live");
    expect((await call(orgId, { on: true, meetingId })).status).toBe(200);
    expect(await events(meetingId)).toEqual([]);
  });
});
