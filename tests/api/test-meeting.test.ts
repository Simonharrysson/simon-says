import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  user: { id: "u1", email: "simon@x.se" } as { id: string; email: string } | null,
  killSwitch: false,
  adminEmails: "Simon@x.se" as string | undefined,
  startMeeting: vi.fn(),
  seed: vi.fn(),
  runFeed: vi.fn(),
  endMeeting: vi.fn(),
  after: vi.fn(),
  getOrg: vi.fn(),
  getGoogleAuth: vi.fn(),
  createTestAgendaDoc: vi.fn(),
  trashTestDoc: vi.fn(),
  testRun: vi.fn(),
  order: [] as string[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => m.after(fn),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }),
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ KILL_SWITCH: m.killSwitch, ADMIN_EMAILS: m.adminEmails, ALARM_EMAIL: "alarm@x.se" }),
}));
vi.mock("@/lib/meetings/start", () => ({ startMeeting: m.startMeeting }));
vi.mock("@/lib/meetings/tick", () => ({ endMeeting: m.endMeeting }));
vi.mock("@/lib/testmeeting/feed", () => ({ seedTestSession: m.seed, runFeed: m.runFeed }));
vi.mock("@/lib/db/orgs", () => ({ getOrg: m.getOrg }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
}));
vi.mock("@/lib/testmeeting/agenda", () => ({
  createTestAgendaDoc: m.createTestAgendaDoc,
  trashTestDoc: m.trashTestDoc,
  testRun: m.testRun,
}));

const { POST } = await import("@/app/api/meetings/test/route");
const { AGENDA_FIXTURE_LINES } = await import("@/lib/testmeeting/fixture");
const { GoogleAuthLostError } = await import("@/lib/google/client");

const ORG = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const call = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api/meetings/test", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(() => {
  Object.assign(m, { user: { id: "u1", email: "simon@x.se" }, killSwitch: false, adminEmails: "Simon@x.se" });
  m.startMeeting.mockReset().mockResolvedValue({ ok: true, meetingId: "m1", docUrl: "https://doc", orgName: "Styrelsen" });
  m.seed.mockReset().mockResolvedValue("test-s1");
  m.runFeed.mockReset().mockResolvedValue("ended");
  m.endMeeting.mockReset().mockResolvedValue("ended");
  m.after.mockReset();
  m.order = [];
  m.getOrg.mockReset().mockResolvedValue({ id: ORG, name: "Testföreningen", meeting_folder_id: "folderX" });
  m.getGoogleAuth.mockReset().mockResolvedValue({ auth: true });
  m.createTestAgendaDoc.mockReset().mockImplementation(async () => (m.order.push("doc"), { docId: "tdoc" }));
  m.trashTestDoc.mockReset().mockResolvedValue(undefined);
  m.testRun.mockReset().mockResolvedValue("a");
  m.startMeeting.mockImplementation(async () => (m.order.push("start"), { ok: true, meetingId: "m1", docUrl: "https://doc", orgName: "Styrelsen" }));
});

describe("POST /api/meetings/test", () => {
  it("401 signed out", async () => {
    m.user = null;
    expect((await call({ orgId: ORG })).status).toBe(401);
    expect(m.startMeeting).not.toHaveBeenCalled();
  });

  it("403 for a non-admin, without starting anything", async () => {
    m.user = { id: "u2", email: "other@x.se" };
    const res = await call({ orgId: ORG });
    expect(res.status).toBe(403);
    expect(m.startMeeting).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });

  it("falls back to ALARM_EMAIL when ADMIN_EMAILS is unset", async () => {
    m.adminEmails = undefined;
    expect((await call({ orgId: ORG })).status).toBe(403);
    m.user = { id: "u3", email: "ALARM@x.se" };
    expect((await call({ orgId: ORG })).status).toBe(200);
  });

  it("400 for a bad org id; 503 under the kill switch", async () => {
    expect((await call({ orgId: "nope" })).status).toBe(400);
    m.killSwitch = true;
    expect((await call({ orgId: ORG })).status).toBe(503);
    expect(m.startMeeting).not.toHaveBeenCalled();
  });

  it("passes the start failure through (409 already live)", async () => {
    m.startMeeting.mockResolvedValue({ ok: false, error: "already_live", status: 409, message: "Ett möte pågår redan" });
    const res = await call({ orgId: ORG });
    expect(res.status).toBe(409);
    expect(m.seed).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });

  it("starts as test_started, seeds the session and replays after the response", async () => {
    const res = await call({ orgId: ORG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meetingId: "m1", docUrl: "https://doc" });
    expect(m.startMeeting.mock.calls[0][2]).toBe(ORG);
    expect(m.startMeeting.mock.calls[0][3]).toBe("test_started");
    expect(m.seed).toHaveBeenCalledWith("m1");
    expect(m.runFeed).not.toHaveBeenCalled(); // only inside after()
    await m.after.mock.calls[0][0]();
    expect(m.runFeed).toHaveBeenCalledWith("m1", "test-s1", expect.any(Number));
  });

  it("answers 500 at once if the session cannot be seeded, and abandons the meeting after the response", async () => {
    m.seed.mockRejectedValue(new Error("db"));
    const res = await call({ orgId: ORG });
    expect(res.status).toBe(500);
    expect(m.endMeeting).not.toHaveBeenCalled(); // not inline
    expect(m.after).toHaveBeenCalledTimes(1);
    await m.after.mock.calls[0][0]();
    expect(m.endMeeting).toHaveBeenCalledWith("m1", { abandon: true });
    expect(m.runFeed).not.toHaveBeenCalled();
  });

  it("mode absent (and \"new\") is today's flow: no agenda Doc, no Google call here", async () => {
    for (const body of [{ orgId: ORG }, { orgId: ORG, mode: "new" }]) {
      const res = await call(body);
      expect(res.status).toBe(200);
    }
    expect(m.createTestAgendaDoc).not.toHaveBeenCalled();
    expect(m.getGoogleAuth).not.toHaveBeenCalled();
    expect(m.testRun).not.toHaveBeenCalled();
    expect(m.startMeeting.mock.calls[0]).toHaveLength(4); // no options
  });

  it("400 for an unknown mode, before anything is started", async () => {
    expect((await call({ orgId: ORG, mode: "agendas" })).status).toBe(400);
    expect((await call({ orgId: ORG, mode: 1 })).status).toBe(400);
    expect(m.startMeeting).not.toHaveBeenCalled();
    expect(m.createTestAgendaDoc).not.toHaveBeenCalled();
  });
});

describe("POST /api/meetings/test, mode agenda (A13)", () => {
  it("creates the fictional agenda Doc, then starts a test meeting in it in agenda mode, then replays run A", async () => {
    const res = await call({ orgId: ORG, mode: "agenda" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meetingId: "m1", docUrl: "https://doc" });
    expect(m.order).toEqual(["doc", "start"]);
    expect(m.getGoogleAuth).toHaveBeenCalledWith("u1");
    expect(m.createTestAgendaDoc).toHaveBeenCalledWith(
      { auth: true },
      { orgName: "Testföreningen", folderId: "folderX", startedAt: expect.any(Date) },
    );
    const [, user, orgId, kind, opts] = m.startMeeting.mock.calls[0];
    expect([user.id, orgId, kind]).toEqual(["u1", ORG, "test_started"]);
    expect(opts).toEqual({ agendaDocId: "tdoc", formatKind: "veckomote", transcriptInDoc: false, isTest: true });
    expect(m.seed).toHaveBeenCalledWith("m1");
    expect(m.runFeed).not.toHaveBeenCalled();
    await m.after.mock.calls[0][0]();
    expect(m.runFeed).toHaveBeenCalledWith("m1", "test-s1", expect.any(Number), undefined, AGENDA_FIXTURE_LINES.a);
    expect(m.trashTestDoc).not.toHaveBeenCalled();
  });

  it("after a done agenda Testmöte the next one replays run B", async () => {
    m.testRun.mockResolvedValue("b");
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(200);
    expect(m.testRun).toHaveBeenCalledWith(ORG);
    await m.after.mock.calls[0][0]();
    expect(m.runFeed.mock.calls[0][4]).toBe(AGENDA_FIXTURE_LINES.b);
  });

  it("no meeting folder: folderId null", async () => {
    m.getOrg.mockResolvedValue({ id: ORG, name: "Testföreningen", meeting_folder_id: null });
    await call({ orgId: ORG, mode: "agenda" });
    expect(m.createTestAgendaDoc.mock.calls[0][1].folderId).toBeNull();
  });

  it("a refused start passes through and the fresh test Doc is trashed (best effort)", async () => {
    m.startMeeting.mockResolvedValue({ ok: false, error: "already_live", status: 409, message: "Ett möte pågår redan" });
    m.trashTestDoc.mockRejectedValue(new Error("drive down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call({ orgId: ORG, mode: "agenda" });
    expect(res.status).toBe(409);
    expect(m.trashTestDoc).toHaveBeenCalledWith({ auth: true }, "tdoc");
    expect(m.seed).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });

  it("404 for an org the user cannot see; 401 when the Google grant is gone; 502 when the Doc cannot be made", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.getOrg.mockResolvedValueOnce(null);
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(404);
    m.getGoogleAuth.mockRejectedValueOnce(new GoogleAuthLostError("u1", "revoked"));
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(401);
    m.createTestAgendaDoc.mockRejectedValueOnce(new Error("docs down"));
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(502);
    expect(m.startMeeting).not.toHaveBeenCalled();
  });

  it("a DB error in testRun gives the Swedish error shape (502), and no Doc", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.testRun.mockRejectedValueOnce(new Error("testRun: db"));
    const res = await call({ orgId: ORG, mode: "agenda" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "doc_failed", message: expect.stringContaining("Försök igen") });
    expect(m.createTestAgendaDoc).not.toHaveBeenCalled();
    expect(m.startMeeting).not.toHaveBeenCalled();
  });

  it("the kill switch and admin checks come first", async () => {
    m.killSwitch = true;
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(503);
    m.killSwitch = false;
    m.user = { id: "u2", email: "other@x.se" };
    expect((await call({ orgId: ORG, mode: "agenda" })).status).toBe(403);
    expect(m.createTestAgendaDoc).not.toHaveBeenCalled();
  });
});
