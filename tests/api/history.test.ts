import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { useTestEnv } from "@/test/env";

// Import tickets are signed with TOKEN_ENC_KEY: a valid env for getEnv().
useTestEnv();

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
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => adminClient() }));
vi.mock("@/lib/google/client", () => ({
  getGoogleAuth: async () => ({ grant: "sign-in" }),
  getImportGoogleAuth: async () => ({ grant: "import" }),
  GoogleAuthLostError: class extends Error {},
  DriveAccessMissingError: class extends Error {},
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
const historyRoute = await import("@/app/api/orgs/[id]/history/route");
const clearDelete = historyRoute.DELETE;
const fixDate = historyRoute.POST;
// DELETE without a body clears; POST with { protocolId, date } corrects a date.
const clear = (r: NextRequest, c: { params: Promise<{ id: string }> }) => (r.method === "DELETE" ? clearDelete(r, c) : fixDate(r, c));
const propose = (await import("@/app/api/orgs/[id]/goals/propose/route")).POST;
const req = (url: string, body?: unknown, method = "POST") =>
  new NextRequest(url, { method, body: method === "DELETE" ? undefined : JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const DOC = "1AbCdEfGhIjKlMnOpQrS";
const oneMeeting = {
  title: "Protokoll",
  split: { ok: true, sections: [{ date: "2025-09-02", title: "Protokoll", text: "Datum: 2025-09-02\nBeslut: att starta ett spelkafé." }] },
};
const running = {
  title: "Protokoll HT25",
  split: {
    ok: true,
    sections: ["2025-09-02", "2025-09-09", "2025-09-16"].map((d) => ({ date: d, title: "Protokoll HT25", text: `Protokoll ${d}\nBeslut: att fortsätta.` })),
  },
};
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
    m.readProtocolDoc.mockResolvedValue(oneMeeting);
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
    m.readProtocolDoc.mockResolvedValueOnce(oneMeeting).mockResolvedValueOnce(running).mockResolvedValueOnce({ title: "X", split: { ok: false, reason: "many-meetings" } });
    const res = await estimate(req("https://x.test/e", { docIds: [DOC, `${DOC}x`, `${DOC}y`] }), ctx(orgId));
    expect(res.status).toBe(200);
    const json = await res.json();
    // One Doc with one meeting, a running Doc with three, one refused.
    expect(json.protocols).toBe(4);
    expect(json.docs).toEqual([
      { docId: DOC, sections: 1 },
      { docId: `${DOC}x`, sections: 3 },
      { docId: `${DOC}y`, error: "many-meetings", message: "Dokumentet verkar innehålla flera möten — välj ett protokoll per dokument eller dela upp det." },
    ]);
    expect(json.totalUsd).toBeGreaterThan(0);
    expect(m.extractProtocol).not.toHaveBeenCalled();
    expect((await estimate(req("https://x.test/e", { docIds: ["../x"] }), ctx(orgId))).status).toBe(400);
  });

  it("the read access is used only for files with a valid ticket from the admin's listing", async () => {
    m.db = admin.db;
    const { fileTicket } = await import("@/lib/history/ticket");
    const t = fileTicket(admin.id, orgId, DOC);
    expect((await estimate(req("https://x.test/e", { docIds: [DOC], tickets: { [DOC]: t } }), ctx(orgId))).status).toBe(200);
    expect(m.readProtocolDoc.mock.calls.at(-1)![0]).toEqual({ grant: "import" });
    // Without tickets (the Picker): the sign-in grant.
    await estimate(req("https://x.test/e", { docIds: [DOC] }), ctx(orgId));
    expect(m.readProtocolDoc.mock.calls.at(-1)![0]).toEqual({ grant: "sign-in" });
    // Another file's ticket, another user's, or a forged one: refused before any read.
    const calls = m.readProtocolDoc.mock.calls.length;
    expect((await estimate(req("https://x.test/e", { docIds: [`${DOC}x`], tickets: { [`${DOC}x`]: t } }), ctx(orgId))).status).toBe(400);
    expect((await estimate(req("https://x.test/e", { docIds: [DOC], tickets: { [DOC]: fileTicket(member.id, orgId, DOC) } }), ctx(orgId))).status).toBe(400);
    expect((await importOne(req("https://x.test/i", { docId: DOC, ticket: "1.forged" }), ctx(orgId))).status).toBe(400);
    expect(m.readProtocolDoc.mock.calls.length).toBe(calls);
  });

  it("import: stores only the cleaned items (never the text), falls back to the file date", async () => {
    m.db = admin.db;
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol("2025-09-02"), usage });
    const res = await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: "2025-09-02", dateFrom: "doc", decisions: 1, reports: 1 });
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol(null), usage });
    const res2 = await importOne(req("https://x.test/i", { docId: `${DOC}2` }), ctx(orgId));
    // No date from Claude: the section's dated heading.
    expect(await res2.json()).toMatchObject({ date: "2025-09-02", dateFrom: "doc" });
    // No date anywhere: the file's creation date, which the admin can correct.
    m.readProtocolDoc.mockResolvedValueOnce({ title: "P", split: { ok: true, sections: [{ date: null, title: "P", text: "Beslut: att starta." }] } });
    m.extractProtocol.mockResolvedValueOnce({ ok: true, protocol: protocol(null), usage });
    const res3 = await importOne(req("https://x.test/i", { docId: `${DOC}4` }), ctx(orgId));
    const j3 = await res3.json();
    expect(j3).toMatchObject({ date: "2025-10-01", dateFrom: "file" });
    const fix = await clear(req("https://x.test/c", { protocolId: j3.protocolId, date: "2025-08-01" }), ctx(orgId));
    expect(fix.status).toBe(200);
    const fixFuture = await clear(req("https://x.test/c", { protocolId: j3.protocolId, date: "2099-08-01" }), ctx(orgId));
    expect(fixFuture.status).toBe(400);
    await adminClient().from("history_protocols").delete().eq("id", j3.protocolId);
    const { data } = await adminClient().from("history_items").select("text").eq("org_id", orgId);
    expect(JSON.stringify(data)).not.toContain("Datum: 2025-09-02");
    expect(m.extractProtocol.mock.calls[0][0]).toMatchObject({ orgId, text: expect.stringContaining("Beslut") });
  });

  it("a running Doc: each section is its own import; a changed Doc is refused; Simon Says' own Doc is refused", async () => {
    m.db = admin.db;
    m.readProtocolDoc.mockResolvedValue(running);
    m.extractProtocol.mockResolvedValue({ ok: true, protocol: protocol(null), usage });
    for (let k = 0; k < 3; k++) {
      const r = await importOne(req("https://x.test/i", { docId: "runningDoc01", section: k, sections: 3 }), ctx(orgId));
      expect((await r.json()).date).toBe(running.split.sections[k].date);
    }
    expect(m.extractProtocol.mock.calls.map((c) => c[0].text)).toEqual(running.split.sections.map((x) => x.text));
    expect((await importOne(req("https://x.test/i", { docId: "runningDoc01", section: 0, sections: 2 }), ctx(orgId))).status).toBe(409);
    const { data: rows } = await adminClient().from("history_protocols").select("section").eq("drive_file_id", "runningDoc01").order("section");
    expect(rows).toEqual([{ section: 0 }, { section: 1 }, { section: 2 }]);
    await adminClient().from("history_protocols").delete().eq("drive_file_id", "runningDoc01");

    const { meetingId } = await seedMeeting(orgId, admin.id);
    await adminClient().from("meetings").update({ doc_id: "ownSimonSaysDoc01" }).eq("id", meetingId);
    const calls = m.extractProtocol.mock.calls.length;
    const own = await importOne(req("https://x.test/i", { docId: "ownSimonSaysDoc01" }), ctx(orgId));
    expect(own.status).toBe(422);
    expect((await own.json()).error).toBe("own_doc");
    const est = await estimate(req("https://x.test/e", { docIds: ["ownSimonSaysDoc01"] }), ctx(orgId));
    expect((await est.json()).docs[0].error).toBe("own_doc");
    expect(m.extractProtocol.mock.calls.length).toBe(calls);
  });

  it("only a call the spend gate stopped gives the claim back; a failed or timed-out request keeps it", async () => {
    m.db = admin.db;
    const before = await adminClient().from("history_import_claims").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    m.extractProtocol.mockResolvedValueOnce({ ok: false, error: "spend", usage: null });
    expect((await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId))).status).toBe(503);
    const after = await adminClient().from("history_import_claims").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    expect(after.count).toBe(before.count);
    // A request that failed or timed out (no usage) may have run at Claude: the claim stays.
    m.extractProtocol.mockResolvedValueOnce({ ok: false, error: "error", usage: null });
    expect((await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId))).status).toBe(502);
    m.extractProtocol.mockResolvedValueOnce({ ok: false, error: "malformed", usage });
    expect((await importOne(req("https://x.test/i", { docId: DOC }), ctx(orgId))).status).toBe(502);
    const billed = await adminClient().from("history_import_claims").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    expect(billed.count).toBe((before.count ?? 0) + 2);
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
    // Three imported protocols and the one Simon Says meeting (it holds a decision).
    expect(m.digestGoals.mock.calls[0][0].history).toHaveLength(4);
  });

  it("clear: removes the imported protocols; propose then falls back to the meetings-only path", async () => {
    m.db = admin.db;
    const res = await clear(req("https://x.test/c", undefined, "DELETE"), ctx(orgId));
    expect(await res.json()).toEqual({ ok: true, removed: 3 });
    // One ended meeting and no imports: the old path's "too few".
    expect((await propose(req("https://x.test/p"), ctx(orgId))).status).toBe(409);
    expect(m.digestGoals).not.toHaveBeenCalled();
  });
});
