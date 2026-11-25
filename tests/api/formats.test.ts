import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { VECKOMOTE } from "@/lib/formats/standard";
import type { DocStructure } from "@/lib/formats/structure";

// Against the local stack as real signed-in users (RLS and set_default_format decide). Google
// and Claude are mocked: the fictional fixture Doc stands in for every picked Doc.
const m = vi.hoisted(() => ({
  db: null as SupabaseClient | null,
  getGoogleAuth: vi.fn(async () => ({})),
  documentsGet: vi.fn(),
  filesGet: vi.fn(),
  proposeFormat: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: m.documentsGet } }),
  driveApi: () => ({ files: { get: m.filesGet } }),
}));
vi.mock("@/lib/formats/learn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/formats/learn")>()),
  proposeFormat: m.proposeFormat,
}));

const propose = (await import("@/app/api/orgs/[id]/formats/propose/route")).POST;
const approve = (await import("@/app/api/orgs/[id]/formats/route")).POST;
const { orgDefaultFormat } = await import("@/lib/formats/store");

const req = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const callPropose = (orgId: string, body: unknown) =>
  propose(req(`https://x.test/api/orgs/${orgId}/formats/propose`, body), { params: Promise.resolve({ id: orgId }) });
const callApprove = (orgId: string, body: unknown) =>
  approve(req(`https://x.test/api/orgs/${orgId}/formats`, body), { params: Promise.resolve({ id: orgId }) });

const folderOf = async (orgId: string) =>
  (await adminClient().from("orgs").select("meeting_folder_id").eq("id", orgId).single()).data!.meeting_folder_id as string | null;

const LEARNED = { ...VECKOMOTE, kind: "learned" as const, title: "Protokoll Ekdala" };
const SCHEMA_KEYS = Object.keys(VECKOMOTE).sort();
const PRIVATE = ["Sommarfest på Kårallen", "Workshop om sponsring", "Elin Berglund", "Boka lokal"];

describe.skipIf(!hasLocalSupabase)("format learning routes", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("learn-admin"), createTestUser("learn-member")]);
    const r = await createOrg(admin.db, "Lärföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  beforeEach(() => {
    m.documentsGet.mockReset();
    m.filesGet.mockReset();
    m.proposeFormat.mockReset();
    m.documentsGet.mockImplementation(async ({ documentId }: { documentId: string }) => ({
      data: { ...fixture, documentId, title: documentId.startsWith("mall") ? "Mall veckomöte" : "Veckomöte 12 mars" },
    }));
    m.filesGet.mockResolvedValue({ data: { parents: ["folderParent0001"] } });
    m.proposeFormat.mockResolvedValue({
      ok: true,
      profile: LEARNED,
      explanation: "Förklaring.",
      qualityNote: "Kvalitet.",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0 },
    });
  });

  it("member → 403 on both routes, nothing called or stored", async () => {
    m.db = member.db;
    expect((await callPropose(orgId, { docIds: ["docAAAA11111"] })).status).toBe(403);
    expect((await callApprove(orgId, { profile: LEARNED, folderId: "folderAAAA1111" })).status).toBe(403);
    expect(m.documentsGet).not.toHaveBeenCalled();
    expect(m.proposeFormat).not.toHaveBeenCalled();
    expect((await orgDefaultFormat(admin.db, orgId)).id).toBeNull();
    expect(await folderOf(orgId)).toBeNull();
  });

  it("propose: 0 or 6 ids → 400", async () => {
    m.db = admin.db;
    expect((await callPropose(orgId, { docIds: [] })).status).toBe(400);
    const six = Array.from({ length: 6 }, (_, i) => `docAAAA1111${i}`);
    expect((await callPropose(orgId, { docIds: six })).status).toBe(400);
    expect((await callPropose(orgId, { docIds: ["../bad"] })).status).toBe(400);
    expect(m.documentsGet).not.toHaveBeenCalled();
  });

  it("propose: structure only reaches Claude and the logs; template flagged; nothing stored", async () => {
    m.db = admin.db;
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const info = vi.spyOn(console, "info").mockImplementation(capture);
    const error = vi.spyOn(console, "error").mockImplementation(capture);
    const res = await callPropose(orgId, { docIds: ["docAAAA11111", "mallBBBB2222"] });
    info.mockRestore();
    error.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: LEARNED, explanation: "Förklaring.", qualityNote: "Kvalitet.", folderId: "folderParent0001" });
    expect(m.documentsGet).toHaveBeenCalledWith({ documentId: "docAAAA11111", includeTabsContent: true });
    expect(m.filesGet).toHaveBeenCalledWith(expect.objectContaining({ fileId: "docAAAA11111", fields: "parents" }));

    const input = m.proposeFormat.mock.calls[0][0] as { orgId: string; docs: { isTemplate: boolean; structure: DocStructure }[] };
    expect(input.orgId).toBe(orgId);
    expect(input.docs.map((d) => d.isTemplate)).toEqual([false, true]);
    expect(input.docs[0].structure.topItems).toContain("Kommande event");
    const sent = JSON.stringify(input) + logs.join("\n");
    for (const text of [...PRIVATE, "Veckomöte 12 mars", "Mall veckomöte"]) expect(sent).not.toContain(text);
    expect((await orgDefaultFormat(admin.db, orgId)).id).toBeNull();
    expect(await folderOf(orgId)).toBeNull();
  });

  it("propose: kill switch → 503", async () => {
    m.db = admin.db;
    m.proposeFormat.mockResolvedValue({ ok: false, error: "spend" });
    expect((await callPropose(orgId, { docIds: ["docAAAA11111"] })).status).toBe(503);
  });

  it("approve: invalid profile → 400", async () => {
    m.db = admin.db;
    expect((await callApprove(orgId, { profile: { ...LEARNED, numbering: "roman" } })).status).toBe(400);
    expect((await callApprove(orgId, { profile: LEARNED, folderId: "../x" })).status).toBe(400);
    expect((await orgDefaultFormat(admin.db, orgId)).id).toBeNull();
  });

  it("approve: learned row becomes the default with schema keys only; folder set once", async () => {
    m.db = admin.db;
    const res = await callApprove(orgId, {
      profile: {
        ...LEARNED,
        kind: "enkel",
        decisionPrefix: "B:",
        minutes: "Sommarfest på Kårallen",
        fixedAgendaItems: [{ key: "other", label: "Övrigt", role: "other", position: "last", body: "Elin Berglund" }],
      },
      folderId: "folderFirst0001",
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const def = await orgDefaultFormat(member.db, orgId);
    expect(def.id).toBe(id);
    expect(def.profile.kind).toBe("learned");
    expect(def.profile.decisionPrefix).toBe("Beslut:");
    expect(await folderOf(orgId)).toBe("folderFirst0001");

    const { data: row } = await adminClient().from("format_profiles").select("kind, profile, is_default").eq("id", id).single();
    expect(row!.kind).toBe("learned");
    expect(row!.is_default).toBe(true);
    expect(Object.keys(row!.profile as object).sort()).toEqual(SCHEMA_KEYS);
    expect(JSON.stringify(row!.profile)).not.toMatch(/Sommarfest|Elin Berglund|"minutes"|"body"/);

    // A second approval never overwrites the folder.
    const again = await callApprove(orgId, { profile: LEARNED, folderId: "folderSecond0002" });
    expect(again.status).toBe(200);
    expect((await orgDefaultFormat(admin.db, orgId)).id).toBe((await again.json()).id);
    expect(await folderOf(orgId)).toBe("folderFirst0001");
    const { count } = await adminClient().from("format_profiles").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("is_default", true);
    expect(count).toBe(1);
  });
});
