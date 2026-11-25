import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { ENKEL, STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";

const current = vi.hoisted(() => ({ db: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

const { POST } = await import("@/app/api/orgs/[id]/format/route");
const { orgDefaultFormat, listOrgFormats } = await import("@/lib/formats/store");

const call = (orgId: string, body: unknown) =>
  POST(
    new NextRequest(`https://x.test/api/orgs/${orgId}/format`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: orgId }) },
  );

describe.skipIf(!hasLocalSupabase)("POST /api/orgs/[id]/format", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  let emptyOrgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("admin"), createTestUser("member")]);
    const r = await createOrg(admin.db, "Styrelsen");
    const e = await createOrg(admin.db, "Tom");
    if (!r.ok || !e.ok) throw new Error("org");
    orgId = r.id;
    emptyOrgId = e.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("an org without rows defaults to Enkel with id null", async () => {
    expect(await orgDefaultFormat(admin.db, emptyOrgId)).toEqual({ id: null, profile: ENKEL });
  });

  it("member gets 403 and nothing changes", async () => {
    current.db = member.db;
    const res = await call(orgId, { kind: "styrelseprotokoll" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Bara administratörer kan byta mötesformat." });
    expect((await orgDefaultFormat(admin.db, orgId)).id).toBeNull();
  });

  it("admin sets Veckomöte, then Styrelseprotokoll; one default; earlier version can be re-adopted", async () => {
    current.db = admin.db;
    const res = await call(orgId, { kind: "veckomote" });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(await orgDefaultFormat(member.db, orgId)).toEqual({ id, profile: VECKOMOTE });

    expect((await call(orgId, { kind: "styrelseprotokoll" })).status).toBe(200);
    expect((await orgDefaultFormat(admin.db, orgId)).profile).toEqual(STYRELSEPROTOKOLL);
    const list = await listOrgFormats(admin.db, orgId);
    expect(list).toHaveLength(2);
    expect(list.filter((f) => f.isDefault)).toHaveLength(1);
    // Standard rows are not custom (R3-I2: only custom versions are offered by id).
    expect(list.map((f) => [f.kind, f.custom, f.requiredCount])).toEqual([
      ["styrelseprotokoll", false, 0],
      ["veckomote", false, 0],
    ]);

    expect((await call(orgId, { profileId: id })).status).toBe(200);
    expect((await orgDefaultFormat(admin.db, orgId)).profile).toEqual(VECKOMOTE);
  });

  it("rejects an unknown kind", async () => {
    current.db = admin.db;
    expect((await call(orgId, { kind: "nope" })).status).toBe(400);
  });
});
