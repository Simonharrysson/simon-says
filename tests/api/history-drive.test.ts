import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { DOC_MIME, FOLDER_MIME } from "@/lib/history/drive-list";

// The import's own Drive browser against the local stack as real signed-in users. Google is a
// fake Drive; fictional förening and titles.

const FOLDER = "1FolderProtokollAAA";
const DOC_NEW = "1DocNyttProtokollAAA";
const DOC_DONE = "1DocRedanInlastAAAA";
const DOC_OWN = "1DocSimonSaysEgetAA";

const m = vi.hoisted(() => ({
  db: null as SupabaseClient | null,
  access: true,
  deleted: 0,
  driveCalls: 0,
  driveError: null as unknown,
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => adminClient() }));
vi.mock("@/lib/google/client", () => ({
  getImportGoogleAuth: async () => ({}),
  hasImportAccess: async () => m.access,
  deleteImportToken: async () => {
    m.deleted++;
  },
  DriveAccessMissingError: class extends Error {},
}));
vi.mock("@/lib/google/docs", () => ({
  driveApi: () => ({
    files: {
      async list(p: { q: string }) {
        m.driveCalls++;
        if (m.driveError) throw m.driveError;
        if (p.q.includes(`mimeType = '${DOC_MIME}'`)) {
          return {
            data: {
              files: [
                { id: DOC_NEW, name: "Styrelsemöte 2025-09-02", mimeType: DOC_MIME, createdTime: "2025-09-02T18:00:00Z" },
                { id: DOC_DONE, name: "Styrelsemöte 2025-08-12", mimeType: DOC_MIME, createdTime: "2025-08-12T18:00:00Z" },
                { id: DOC_OWN, name: "2025-10-01 18.00 Mötesprotokoll – Rutan", mimeType: DOC_MIME, createdTime: "2025-10-01T18:00:00Z" },
              ],
            },
          };
        }
        return { data: { files: [{ id: FOLDER, name: "Protokoll" }] } };
      },
      async get() {
        m.driveCalls++;
        return { data: { id: FOLDER, name: "Protokoll", mimeType: FOLDER_MIME } };
      },
    },
    drives: { list: async () => ({ data: { drives: [] } }) },
  }),
}));

const { POST, DELETE } = await import("@/app/api/orgs/[id]/history/drive/route");
const { checkTicket } = await import("@/lib/history/ticket");
const req = (body: unknown) => new NextRequest("https://x.test/d", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasLocalSupabase)("history drive browser route", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("hdadmin"), createTestUser("hdmember")]);
    const r = await createOrg(admin.db, "Brädspelsföreningen Rutan");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
    const { meetingId } = await seedMeeting(orgId, admin.id);
    await adminClient().from("meetings").update({ doc_id: DOC_OWN }).eq("id", meetingId);
    const { error } = await adminClient()
      .from("history_protocols")
      .insert({ org_id: orgId, drive_file_id: DOC_DONE, section: 0, meeting_date: "2025-08-12", date_from: "doc" });
    if (error) throw new Error(error.message);
  });

  beforeEach(() => {
    m.access = true;
    m.deleted = 0;
    m.driveCalls = 0;
    m.driveError = null;
  });

  it("a member gets 403 and Drive is never called", async () => {
    m.db = member.db;
    expect((await POST(req({ action: "folders", place: "root" }), ctx(orgId))).status).toBe(403);
    expect(m.driveCalls).toBe(0);
  });

  it("an admin without the import's read access gets needs_drive_access, Drive untouched", async () => {
    m.db = admin.db;
    m.access = false;
    const res = await POST(req({ action: "folders", place: "root" }), ctx(orgId));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("needs_drive_access");
    expect(m.driveCalls).toBe(0);
  });

  it("lists folders; bad places and ids are refused", async () => {
    m.db = admin.db;
    const res = await POST(req({ action: "folders", place: "root" }), ctx(orgId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folders: [{ id: FOLDER, name: "Protokoll" }], nextPageToken: null });
    expect((await POST(req({ action: "folders", place: "folder", id: "' or '" }), ctx(orgId))).status).toBe(400);
    expect((await POST(req({ action: "folders", place: "everywhere" }), ctx(orgId))).status).toBe(400);
    expect((await POST(req({ action: "files", folders: [] }), ctx(orgId))).status).toBe(400);
  });

  it("lists the Docs in a folder: already imported and Simon Says' own are marked", async () => {
    m.db = admin.db;
    const res = await POST(req({ action: "files", folders: [{ id: FOLDER }], subfolders: false }), ctx(orgId));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files.map((f: { id: string; status: string; date: string }) => [f.id, f.status, f.date])).toEqual([
      [DOC_DONE, "imported", "2025-08-12"],
      [DOC_NEW, "ready", "2025-09-02"],
      [DOC_OWN, "own", "2025-10-01"],
    ]);
    // Tickets only for files the import may read, each valid for exactly that file.
    const byId = Object.fromEntries(json.files.map((f: { id: string; ticket?: string }) => [f.id, f.ticket]));
    expect(byId[DOC_OWN]).toBeUndefined();
    expect(checkTicket(byId[DOC_NEW], admin.id, orgId, DOC_NEW)).toBe(true);
    expect(checkTicket(byId[DOC_NEW], admin.id, orgId, DOC_DONE)).toBe(false);
  });

  it("Ta bort läsåtkomst deletes our copy", async () => {
    m.db = admin.db;
    const res = await DELETE(new NextRequest("https://x.test/d", { method: "DELETE" }), ctx(orgId));
    expect(res.status).toBe(200);
    expect(m.deleted).toBe(1);
  });

  it("Drive saying the scope is insufficient (grant withdrawn) asks for access again", async () => {
    m.db = admin.db;
    m.driveError = { code: 403, message: "Request had insufficient authentication scopes." };
    const res = await POST(req({ action: "folders", place: "shared" }), ctx(orgId));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("needs_drive_access");
  });

  it("caps folders listed per user: one claim per folder, the 121st within 10 minutes is refused", async () => {
    m.db = admin.db;
    await adminClient().from("drive_listing_claims").delete().eq("user_id", admin.id);
    expect((await POST(req({ action: "files", folders: [{ id: FOLDER }, { id: "1FolderProtokollBBB" }] }), ctx(orgId))).status).toBe(200);
    const { count } = await adminClient().from("drive_listing_claims").select("id", { count: "exact", head: true }).eq("user_id", admin.id);
    expect(count).toBe(2);
    const { error } = await adminClient()
      .from("drive_listing_claims")
      .insert(Array.from({ length: 118 }, () => ({ org_id: orgId, user_id: admin.id })));
    if (error) throw new Error(error.message);
    const res = await POST(req({ action: "folders", place: "root" }), ctx(orgId));
    expect(res.status).toBe(429);
  });
});
