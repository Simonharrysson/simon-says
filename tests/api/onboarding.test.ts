import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// Onboarding routes (todo #5) against the local stack as real signed-in users. Google and Claude
// are mocked; the förening and its stadgar are fictional.
const m = vi.hoisted(() => ({
  db: null as SupabaseClient | null,
  getGoogleAuth: vi.fn(async () => ({})),
  filesGet: vi.fn(),
  filesExport: vi.fn(),
  extract: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
}));
vi.mock("@/lib/google/drive-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/drive-account")>()),
  // No förening Drive account here (0070): the admin's own grant, as before (lib/google/drive-account.test.ts covers the rest).
  pickerAuth: async (userId: string) => ({ auth: await (m.getGoogleAuth as (id: string) => unknown)(userId), account: null }),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: () => ({ files: { get: m.filesGet, export: m.filesExport } }),
}));
vi.mock("@/lib/formats/stadgar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/formats/stadgar")>()),
  extractArsmoteItems: m.extract,
}));

const stadgar = (await import("@/app/api/orgs/[id]/onboarding/stadgar/route")).POST;
const formats = (await import("@/app/api/orgs/[id]/onboarding/formats/route")).POST;
const logo = await import("@/app/api/orgs/[id]/logo/route");
const { orgDefaultFormat } = await import("@/lib/formats/store");
const profile = async (id: string) => (await adminClient().from("format_profiles").select("profile").eq("id", id).single()).data!.profile as { requiredItems: string[]; fixedAgendaItems: { label: string }[] };

const json = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);

describe.skipIf(!hasLocalSupabase)("onboarding routes", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("obr-adm"), createTestUser("obr-mem")]);
    const r = await createOrg(admin.db, "Rutt-föreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    await joinOrg(member.db, data!.invite_code as string);
  });

  it("stadgar: one call gives the årsmöte's agenda only; members are refused", async () => {
    m.filesGet.mockResolvedValue({ data: { mimeType: "application/vnd.google-apps.document" } });
    m.filesExport.mockResolvedValue({ data: "§ 7 Årsmöte. Vid årsmötet behandlas …" });
    m.extract.mockResolvedValue({ ok: true, items: ["Mötets öppnande", "Val av revisorer"], usage: {} });
    m.db = member.db;
    expect((await stadgar(json("https://x.test", { fileId: "abcdefghijklmnop12345" }), ctx(orgId))).status).toBe(403);
    m.db = admin.db;
    const res = await stadgar(json("https://x.test", { fileId: "abcdefghijklmnop12345" }), ctx(orgId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ arsmote: ["Mötets öppnande", "Val av revisorer"] });
    expect(m.extract).toHaveBeenCalledTimes(1);
  });

  it("formats: Veckomöte becomes the default; the stadgar's årsmöte is stored beside it, no board items (todo #15)", async () => {
    m.db = admin.db;
    // An older browser tab may still send `board`: ignored, never stored.
    const res = await formats(json("https://x.test", { weekly: true, board: ["Fråga om beslutsmässighet"], arsmote: ["Mötets öppnande", "Val av revisorer"] }), ctx(orgId));
    expect(res.status).toBe(200);
    expect((await orgDefaultFormat(admin.db, orgId)).profile.kind).toBe("veckomote");
    const { data: org } = await adminClient().from("orgs").select("styrelse_format_id, arsmote_format_id").eq("id", orgId).single();
    expect(org!.styrelse_format_id).toBeNull();
    const ars = await profile(org!.arsmote_format_id as string);
    expect(ars?.fixedAgendaItems.map((i) => i.label)).toEqual(["Mötets öppnande", "Val av revisorer", "Övriga frågor", "Mötets avslutande"]);
    const { count } = await adminClient().from("format_profiles").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("kind", "styrelseprotokoll");
    expect(count).toBe(0);

    m.db = member.db;
    expect((await formats(json("https://x.test", { weekly: true }), ctx(orgId))).status).toBe(403);
  });

  it("logo: admins upload checked bytes; members read them back; SVG is refused", async () => {
    const form = (bytes: Uint8Array<ArrayBuffer>, type: string) => {
      const f = new FormData();
      f.set("logo", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), "logo");
      return new NextRequest("https://x.test", { method: "POST", body: f });
    };
    m.db = member.db;
    expect((await logo.POST(form(PNG, "image/png"), ctx(orgId))).status).toBe(403);
    m.db = admin.db;
    expect((await logo.POST(form(new TextEncoder().encode("<svg/>"), "image/png"), ctx(orgId))).status).toBe(400);
    const ok = await logo.POST(form(PNG, "image/png"), ctx(orgId));
    expect(ok.status).toBe(200);
    m.db = member.db;
    const got = await logo.GET(new NextRequest("https://x.test"), ctx(orgId));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    m.db = admin.db;
    expect((await logo.DELETE(new NextRequest("https://x.test", { method: "DELETE" }), ctx(orgId))).status).toBe(200);
    const { data } = await adminClient().from("orgs").select("logo_updated_at").eq("id", orgId).single();
    expect(data!.logo_updated_at).toBeNull();
  });
});
