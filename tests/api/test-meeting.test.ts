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

const { POST } = await import("@/app/api/meetings/test/route");

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
});
