import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrg } from "@/lib/db/orgs";
import { adminClient, anonClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";

// Task R (migration 0015): cleanup_retention() deletes usage_daily / org_creations older than
// 24 months, keeps newer rows, is idempotent and callable by service_role only.

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe.skipIf(!hasLocalSupabase)("cleanup_retention", () => {
  it("deletes rows older than 24 months, keeps recent ones, second run deletes nothing", async () => {
    const admin = adminClient();
    const u = await createTestUser("ret");
    const r = await createOrg(u.db, `Retention-${randomUUID().slice(0, 8)}`);
    if (!r.ok) throw new Error("org");
    const oldDay = daysAgo(800).toISOString().slice(0, 10);
    const newDay = daysAgo(700).toISOString().slice(0, 10);
    const { error: e1 } = await admin
      .from("usage_daily")
      .insert([
        { org_id: r.id, day: oldDay, seconds: 1 },
        { org_id: r.id, day: newDay, seconds: 2 },
      ]);
    expect(e1).toBeNull();
    const oldOrg = randomUUID();
    const newOrg = randomUUID();
    const { error: e2 } = await admin.from("org_creations").insert([
      { org_id: oldOrg, user_id: u.id, created_at: daysAgo(800).toISOString() },
      { org_id: newOrg, user_id: u.id, created_at: daysAgo(700).toISOString() },
    ]);
    expect(e2).toBeNull();

    const first = await admin.rpc("cleanup_retention");
    expect(first.error).toBeNull();
    expect(Number(first.data[0].usage_daily_deleted)).toBeGreaterThanOrEqual(1);
    expect(Number(first.data[0].org_creations_deleted)).toBeGreaterThanOrEqual(1);

    const usage = await admin.from("usage_daily").select("day").eq("org_id", r.id);
    expect(usage.data?.map((x) => x.day)).toEqual([newDay]);
    const creations = await admin.from("org_creations").select("org_id").in("org_id", [oldOrg, newOrg]);
    expect(creations.data?.map((x) => x.org_id)).toEqual([newOrg]);

    const second = await admin.rpc("cleanup_retention");
    expect(Number(second.data[0].usage_daily_deleted)).toBe(0);
    expect(Number(second.data[0].org_creations_deleted)).toBe(0);
  });

  it("is not callable by authenticated or anon", async () => {
    const u = await createTestUser("ret2");
    expect((await u.db.rpc("cleanup_retention")).error).not.toBeNull();
    expect((await anonClient().rpc("cleanup_retention")).error).not.toBeNull();
  });
});
