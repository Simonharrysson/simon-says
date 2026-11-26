import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminClient,
  anonClient,
  countRows,
  createTestUser,
  hasLocalSupabase,
  seedMeeting,
  type TestUser,
} from "@/test/local-supabase";
import { addPerson, createOrg, joinOrg } from "@/lib/db/orgs";

// The route handlers run against the local stack as a real signed-in user: the mocked
// server client is that user's client, so RLS decides exactly as in production.
const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

const { DELETE: deleteOrgRoute } = await import("@/app/api/orgs/[id]/route");
const { DELETE: deleteMeetingRoute } = await import("@/app/api/meetings/[id]/route");

const as = (user: TestUser | null) => {
  current.db = user ? user.db : anonClient();
};

const callDeleteMeeting = (id: string) =>
  deleteMeetingRoute(new NextRequest(`https://x.test/api/meetings/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

const callDeleteOrg = (id: string, confirmName?: string) =>
  deleteOrgRoute(
    new NextRequest(`https://x.test/api/orgs/${id}`, {
      method: "DELETE",
      body: JSON.stringify(confirmName === undefined ? {} : { confirmName }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

describe.skipIf(!hasLocalSupabase)("deletion", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([
      createTestUser("admin"),
      createTestUser("member"),
      createTestUser("outsider"),
    ]);
    const r = await createOrg(admin.db, "Styrelsen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    expect(await joinOrg(member.db, await inviteCode(orgId))).toBe(orgId);
  });

  describe("DELETE /api/meetings/[id]", () => {
    it("removes the meeting's sessions, speaker map, notes and events (cascade)", async () => {
      const { meetingId, sessionId } = await seedMeeting(orgId, admin.id);
      as(admin);
      const res = await callDeleteMeeting(meetingId);
      expect(res.status).toBe(200);
      expect(await countRows("meetings", "id", meetingId)).toBe(0);
      expect(await countRows("el_sessions", "id", sessionId)).toBe(0);
      for (const table of ["speaker_map", "note_items", "meeting_events"]) {
        expect(await countRows(table, "meeting_id", meetingId), table).toBe(0);
      }
    });

    it("lets the member who started it delete it", async () => {
      const { meetingId } = await seedMeeting(orgId, member.id);
      as(member);
      expect((await callDeleteMeeting(meetingId)).status).toBe(200);
      expect(await countRows("meetings", "id", meetingId)).toBe(0);
    });

    it("refuses a member deleting someone else's meeting (403), and outsiders see nothing (404)", async () => {
      const { meetingId } = await seedMeeting(orgId, admin.id);
      as(member);
      expect((await callDeleteMeeting(meetingId)).status).toBe(403);
      as(outsider);
      expect((await callDeleteMeeting(meetingId)).status).toBe(404);
      expect(await countRows("meetings", "id", meetingId)).toBe(1);
    });

    it("refuses deleting a live or ending meeting (409), even directly through the API", async () => {
      for (const status of ["live", "ending"] as const) {
        const { meetingId, sessionId } = await seedMeeting(orgId, admin.id, status);
        as(admin);
        const res = await callDeleteMeeting(meetingId);
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "active" });
        // RLS itself refuses too, not only the route.
        const { data } = await admin.db.from("meetings").delete().eq("id", meetingId).select("id");
        expect(data).toEqual([]);
        expect(await countRows("meetings", "id", meetingId)).toBe(1);
        expect(await countRows("el_sessions", "id", sessionId)).toBe(1);
        await adminClient().from("meetings").update({ status: "done" }).eq("id", meetingId);
      }
    });

    it("401 without a session, 404 for a malformed id", async () => {
      as(null);
      expect((await callDeleteMeeting("00000000-0000-0000-0000-000000000000")).status).toBe(401);
      as(admin);
      expect((await callDeleteMeeting("not-a-uuid")).status).toBe(404);
    });
  });

  describe("DELETE /api/orgs/[id]", () => {
    it("only admins can delete an org, and only with its exact name", async () => {
      as(member);
      expect((await callDeleteOrg(orgId, "Styrelsen")).status).toBe(403);
      as(outsider);
      expect((await callDeleteOrg(orgId, "Styrelsen")).status).toBe(404);
      as(admin);
      expect((await callDeleteOrg(orgId)).status).toBe(400);
      expect((await callDeleteOrg(orgId, "styrelsen")).status).toBe(400);
      expect(await countRows("orgs", "id", orgId)).toBe(1);
    });

    it("refuses deleting an org while one of its meetings is live (409)", async () => {
      const { meetingId } = await seedMeeting(orgId, member.id, "live");
      as(admin);
      expect((await callDeleteOrg(orgId, "Styrelsen")).status).toBe(409);
      const { data } = await admin.db.from("orgs").delete().eq("id", orgId).select("id");
      expect(data).toEqual([]);
      expect(await countRows("orgs", "id", orgId)).toBe(1);
      await adminClient().from("meetings").update({ status: "abandoned" }).eq("id", meetingId);
    });

    it("removes everything under the org, but keeps its usage and creation record", async () => {
      const { meetingId, sessionId } = await seedMeeting(orgId, member.id);
      as(admin);
      expect(await addPerson(admin.db, orgId, "Kalle")).toBe(true);
      const { error } = await adminClient()
        .from("usage_daily")
        .insert({ org_id: orgId, day: new Date().toISOString().slice(0, 10), seconds: 60 });
      expect(error).toBeNull();

      const res = await callDeleteOrg(orgId, "Styrelsen");
      expect(res.status).toBe(200);

      expect(await countRows("orgs", "id", orgId)).toBe(0);
      for (const table of ["org_members", "people", "meetings"]) {
        expect(await countRows(table, "org_id", orgId), table).toBe(0);
      }
      // Spend and the org limits outlive the org.
      expect(await countRows("usage_daily", "org_id", orgId)).toBe(1);
      expect(await countRows("org_creations", "org_id", orgId)).toBe(1);
      expect(await countRows("el_sessions", "id", sessionId)).toBe(0);
      for (const table of ["speaker_map", "note_items", "meeting_events"]) {
        expect(await countRows(table, "meeting_id", meetingId), table).toBe(0);
      }
    });
  });
});
