import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// "Hämta styrelsen från webbplatsen" (0057): attempts are limited per förening by
// claim_website_fetch, and the log is service role only. Fictional data.

describe.skipIf(!hasLocalSupabase)("website fetches (0057)", () => {
  let admin: TestUser;
  let orgId: string;

  beforeAll(async () => {
    admin = await createTestUser("webfetch-adm");
    const r = await createOrg(admin.db, "Webbföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
  });

  it("claims up to the hourly limit, then refuses", async () => {
    const db = adminClient();
    const claims = [];
    for (let i = 0; i < 4; i++) claims.push((await db.rpc("claim_website_fetch", { p_org_id: orgId, p_hour_limit: 3, p_day_limit: 20 })).data);
    expect(claims.slice(0, 3).every((c) => typeof c === "number")).toBe(true);
    expect(claims[3]).toBeNull();
    const { error } = await db.from("website_fetches").update({ outcome: "http_status", found: null }).eq("id", claims[0]);
    expect(error).toBeNull();
  });

  it("refuses bad outcome codes", async () => {
    const { data } = await adminClient().rpc("claim_website_fetch", { p_org_id: orgId, p_hour_limit: 100, p_day_limit: 100 });
    const { error } = await adminClient().from("website_fetches").update({ outcome: "Karin Ekholm" }).eq("id", data);
    expect(error).not.toBeNull();
  });

  it("is closed to signed-in users, even admins", async () => {
    const { error } = await admin.db.rpc("claim_website_fetch", { p_org_id: orgId, p_hour_limit: 100, p_day_limit: 100 });
    expect(error).not.toBeNull();
    const { data } = await admin.db.from("website_fetches").select("id").eq("org_id", orgId);
    expect(data ?? []).toHaveLength(0);
  });
});
