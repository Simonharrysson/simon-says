import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// "Hämta styrelsen från webbplatsen" (0057): attempts are limited per förening by
// claim_website_fetch, and the log is service role only. Fictional data.

describe.skipIf(!hasLocalSupabase)("website fetches (0057)", () => {
  let admin: TestUser;
  let orgId: string;
  let otherOrgId: string;

  const claim = async (org: string, user: string, limits: [number, number, number, number]) =>
    (
      await adminClient().rpc("claim_website_fetch", {
        p_org_id: org,
        p_user_id: user,
        p_hour_limit: limits[0],
        p_day_limit: limits[1],
        p_user_hour_limit: limits[2],
        p_user_day_limit: limits[3],
      })
    ).data as number | null;

  beforeAll(async () => {
    admin = await createTestUser("webfetch-adm");
    const r = await createOrg(admin.db, "Webbföreningen");
    const r2 = await createOrg(admin.db, "Andra föreningen");
    if (!r.ok || !r2.ok) throw new Error("org");
    orgId = r.id;
    otherOrgId = r2.id;
  });

  it("claims up to the förening's hourly limit, then refuses", async () => {
    const claims = [];
    for (let i = 0; i < 4; i++) claims.push(await claim(orgId, admin.id, [3, 20, 100, 100]));
    expect(claims.slice(0, 3).every((c) => typeof c === "number")).toBe(true);
    expect(claims[3]).toBeNull();
    const { error } = await adminClient().from("website_fetches").update({ outcome: "http_status", found: null }).eq("id", claims[0]);
    expect(error).toBeNull();
  });

  it("limits the user across föreningar too", async () => {
    // The user already has 3 attempts (above); in another förening the user limit still counts them.
    expect(await claim(otherOrgId, admin.id, [100, 100, 3, 100])).toBeNull();
    expect(typeof (await claim(otherOrgId, admin.id, [100, 100, 4, 100]))).toBe("number");
  });

  it("refuses bad outcome codes", async () => {
    const id = await claim(orgId, admin.id, [100, 100, 100, 100]);
    const { error } = await adminClient().from("website_fetches").update({ outcome: "Karin Ekholm" }).eq("id", id);
    expect(error).not.toBeNull();
  });

  it("is closed to signed-in users, even admins", async () => {
    const { error } = await admin.db.rpc("claim_website_fetch", { p_org_id: orgId, p_user_id: admin.id, p_hour_limit: 100, p_day_limit: 100, p_user_hour_limit: 100, p_user_day_limit: 100 });
    expect(error).not.toBeNull();
    const { data } = await admin.db.from("website_fetches").select("id").eq("org_id", orgId);
    expect(data ?? []).toHaveLength(0);
  });
});
