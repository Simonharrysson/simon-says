import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

const m = vi.hoisted(() => ({
  user: { id: "u1", email: "Starter@x.se" } as { id: string; email: string } | null,
  active: [] as { id: string }[],
  getOrg: vi.fn(),
  myRole: vi.fn(),
  memberEmails: vi.fn(),
  getGoogleAuth: vi.fn(),
  createMeetingDoc: vi.fn(),
  insert: vi.fn(),
  logEvent: vi.fn(),
  killSwitch: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: m.user } }) },
    from: () => ({
      select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: m.active, error: null }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: () => ({ insert: m.insert }) }) }));
vi.mock("@/lib/db/orgs", () => ({ getOrg: m.getOrg, myRole: m.myRole }));
vi.mock("@/lib/db/members", () => ({ memberEmails: m.memberEmails }));
vi.mock("@/lib/db/events", () => ({ logEvent: m.logEvent }));
vi.mock("@/lib/docs/create", () => ({ createMeetingDoc: m.createMeetingDoc, meetingTitle: (org: string) => `${org} möte` }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ KILL_SWITCH: m.killSwitch }) }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
}));

const { POST } = await import("@/app/api/meetings/route");

const ORG = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const call = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api/meetings", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
const doc = {
  docId: "doc1",
  notesTabId: "t.0",
  transcriptTabId: "t.1",
  headerRange: "ss-x-header",
  headerRendered: "● LIVE · uppdaterad –",
  sectionRanges: { attendees: "a", decision: "b", action: "c", now: "d" },
  shareFailed: [],
};

beforeEach(() => {
  Object.assign(m, { user: { id: "u1", email: "Starter@x.se" }, active: [], killSwitch: false });
  m.getOrg.mockReset().mockResolvedValue({ id: ORG, name: "Styrelsen", share_transcript: true });
  m.myRole.mockReset().mockResolvedValue("member");
  m.memberEmails.mockReset().mockResolvedValue(["starter@x.se", "b@x.se"]);
  m.getGoogleAuth.mockReset().mockResolvedValue({});
  m.createMeetingDoc.mockReset().mockResolvedValue(doc);
  m.insert.mockReset().mockResolvedValue({ error: null });
  m.logEvent.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/meetings", () => {
  it("creates the Doc and the meeting row, and returns meetingId + docUrl", async () => {
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docUrl).toBe("https://docs.google.com/document/d/doc1/edit");
    expect(json.title).toBe("Styrelsen möte");
    const input = m.createMeetingDoc.mock.calls[0][1];
    expect(input).toMatchObject({ orgName: "Styrelsen", shareTranscript: true, meetingId: json.meetingId });
    expect(input.memberEmails).toEqual(["b@x.se"]); // the starter is not shared with
    const row = m.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      id: json.meetingId,
      org_id: ORG,
      started_by: "u1",
      doc_id: "doc1",
      notes_tab_id: "t.0",
      transcript_tab_id: "t.1",
      header_range: "ss-x-header",
      header_rendered: "● LIVE · uppdaterad –",
      section_ranges: doc.sectionRanges,
      status: "live",
    });
    expect(typeof row.consent_confirmed_at).toBe("string");
    expect(m.logEvent).toHaveBeenCalledWith(json.meetingId, "started", expect.any(Object));
  });

  it("401 without a session, 400 without consent or with a bad org id", async () => {
    m.user = null;
    expect((await call({ orgId: ORG, consent: true })).status).toBe(401);
    m.user = { id: "u1", email: "s@x.se" };
    expect((await call({ orgId: ORG })).status).toBe(400);
    expect((await call({ orgId: ORG, consent: "true" })).status).toBe(400);
    expect((await call({ orgId: "nope", consent: true })).status).toBe(400);
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
  });

  it("404 for an org the user cannot see, 403 for a non-member", async () => {
    m.getOrg.mockResolvedValue(null);
    expect((await call({ orgId: ORG, consent: true })).status).toBe(404);
    m.getOrg.mockResolvedValue({ id: ORG, name: "S", share_transcript: true });
    m.myRole.mockResolvedValue(null);
    expect((await call({ orgId: ORG, consent: true })).status).toBe(403);
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
  });

  it("409 when the org already has a live meeting, and creates nothing", async () => {
    m.active = [{ id: "live1" }];
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_live");
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when the Google grant is gone", async () => {
    m.getGoogleAuth.mockRejectedValue(new GoogleAuthLostError("u1", "invalid_grant"));
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("google_auth_lost");
    expect(json.message).toMatch(/Logga ut och in/);
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("leaves no meeting row behind when the Doc cannot be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.createMeetingDoc.mockRejectedValue(new Error("drive down"));
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/mötesdokumentet/);
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("503 when the kill switch is on", async () => {
    m.killSwitch = true;
    expect((await call({ orgId: ORG, consent: true })).status).toBe(503);
  });

  it("still succeeds when only the event log write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.logEvent.mockRejectedValue(new Error("x"));
    expect((await call({ orgId: ORG, consent: true })).status).toBe(200);
  });
});
