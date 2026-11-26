import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// The protocol import and the whole-history goals proposal against the local stack as real
// signed-in users. Google and Claude are mocked; fictional förening and names.
const m = vi.hoisted(() => ({
  db: null as SupabaseClient | null,
  readProtocolDoc: vi.fn(),
  fileCreatedDate: vi.fn(),
  extractProtocol: vi.fn(),
  digestGoals: vi.fn(),
  proposeGoals: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/google/client", () => ({
  getGoogleAuth: async () => ({}),
  GoogleAuthLostError: class extends Error {},
}));
vi.mock("@/lib/history/read-doc", () => ({
  readProtocolDoc: m.readProtocolDoc,
  fileCreatedDate: m.fileCreatedDate,
  googleStatus: () => undefined,
}));
vi.mock("@/lib/history/extract", () => ({ extractProtocol: m.extractProtocol }));
vi.mock("@/lib/history/digest", () => ({ digestGoals: m.digestGoals }));
vi.mock("@/lib/dashboard/goals", () => ({ proposeGoals: m.proposeGoals }));

const estimate = (await import("@/app/api/orgs/[id]/history/estimate/route")).POST;
const importOne = (await import("@/app/api/orgs/[id]/history/import/route")).POST;
const clear = (await import("@/app/api/orgs/[id]/history/route")).DELETE;
const propose = (await import("@/app/api/orgs/[id]/goals/propose/route")).POST;
const req = (url: string, body?: unknown, method = "POST") =>
  new NextRequest(url, { method, body: method === "DELETE" ? undefined : JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const DOC = "1AbCdEfGhIjKlMnOpQrS";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.01 };
const protocol = (date: string | null) => ({
  date,
  items: [
    { kind: "decision", text: "Starta ett spelkafé på biblioteket", topic: "Spelkafé", owner: null, done: null },
    { kind: "report", text: "Biblioteket är positivt", topic: "Spelkafé", owner: null, done: null },
  ],
});

describe.skipIf(!hasLocalSupabase)("history routes", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("hradmin"), createTestUser("hrmember")]);
    const r = await createOrg(admin.db, "Brädspelsföreningen Rutan");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  beforeEach(() => {
    for (const f of [m.readProtocolDoc, m.fileCreatedDate, m.extractProtocol, m.digestGoals, m.proposeGoals]) f.mockReset();
    m.readProtocolDoc.mockResolvedValue({ title: "Protokoll", text: "Datum: 2025-09-02\nBeslut: att starta ett spelkafé." });
    m.fileCreatedDate.mockResolvedValue("2025-10-01");
  });

  it("a member gets 403 everywhere, with no Doc read and no Claude call", async () => {
    m.db = member.db;
    expect((await estimate(req("https://x.test/e", { docIds: [DOC] }), ctx(orgId))).status).toBe(403);
    expect((await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId))).status).toBe(403);
    expect((await clear(req("https://x.test/c", undefined, "DELETE"), ctx(orgId))).status).toBe(403);
    expect(m.readProtocolDoc).not.toHaveBeenCalled();
    expect(m.extractProtocol).not.toHaveBeenCalled();
  });

  it("estimate: reads the Docs, returns a cost, makes no Claude call; bad ids refused", async () => {
    m.db = admin.db;
    const res = await estimate(req("https://x.test/e", { docIds: [DOC, `${DOC}x`] }), ctx(orgId));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.protocols).toBe(2);
    expect(json.totalUsd).toBeGreaterThan(0);
    expect(m.extractProtocol).not.toHaveBeenCalled();
    expect((await estimate(req("https://x.test/e", { docIds: ["../x"] }), ctx(orgId))).status).toBe(400);
  });

  it("import: stores only the cleaned items (never the text), falls back to the file date", async () => {
    m.db = admin.db;
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol("2025-09-02"), usage });
    const res = await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: "2025-09-02", dateFrom: "doc", decisions: 1, reports: 1 });
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol(null), usage });
    const res2 = await importOne(req("https://x.test/i", { docId: `${DOC}2` }), ctx(orgId));
    expect(await res2.json()).toMatchObject({ date: "2025-10-01", dateFrom: "file" });
    const { data } = await adminClient().from("history_items").select("text").eq("org_id", orgId);
    expect(JSON.stringify(data)).not.toContain("Datum: 2025-09-02");
    expect(m.extractProtocol.mock.calls[0][0]).toMatchObject({ orgId, text: expect.stringContaining("Beslut") });
  });

  it("propose with imported protocols: the whole-history digest, current goals to approve, the rest as suggestions", async () => {
    m.db = admin.db;
    // A third protocol so there are ≥ 3 meetings.
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol("2025-11-04"), usage });
    await importOne(req("https://x.test/i", { docId: `${DOC}3` }), ctx(orgId));
    m.digestGoals.mockResolvedValueOnce({
      ok: true,
      goals: [
        { title: "Spelkafé på biblioteket", status: "current", why: "Pågår.", earlierNames: [], firstMentioned: "2025-09-02", lastMentioned: "2025-11-04", evidence: [] },
        { title: "Eget förråd", status: "stale", why: "Tystnat.", earlierNames: [], firstMentioned: "2025-09-02", lastMentioned: "2025-09-02", evidence: [] },
      ],
      explanation: "Två mål.",
      demoted: 0,
      droppedEvidence: 0,
      answer: {},
      usage,
    });
    const res = await propose(req("https://x.test/p"), ctx(orgId));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("history");
    expect(json.goals).toEqual([{ title: "Spelkafé på biblioteket", why: "Pågår.", evidence: [] }]);
    expect(json.others).toEqual([{ title: "Eget förråd", why: "Tystnat.", status: "stale", lastMentioned: "2025-09-02", evidence: [] }]);
    expect(m.proposeGoals).not.toHaveBeenCalled();
    expect(m.digestGoals.mock.calls[0][0].history).toHaveLength(3);
  });

  it("clear: removes the imported protocols; propose then falls back to the meetings-only path", async () => {
    m.db = admin.db;
    const res = await clear(req("https://x.test/c", undefined, "DELETE"), ctx(orgId));
    expect(await res.json()).toEqual({ ok: true, removed: 3 });
    // No ended meetings and no imports: the old path's "too few".
    expect((await propose(req("https://x.test/p"), ctx(orgId))).status).toBe(409);
    expect(m.digestGoals).not.toHaveBeenCalled();
  });
});
