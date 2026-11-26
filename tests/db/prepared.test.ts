import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// 0033: prepared_agendas — one per förening and date, members read, and the lease that keeps two
// "Skapa dagordning" on the same agenda from planning from the same state.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
const { acquireLease, releaseLease, preparedForDate } = await import("@/lib/prepare/store");

const [T1, T2, T3] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

describe.skipIf(!hasLocalSupabase)("prepared agendas (0033)", () => {
  let orgId: string;
  let id: string;
  let memberDb: Awaited<ReturnType<typeof createTestUser>>["db"];

  beforeAll(async () => {
    const user = await createTestUser("prepared");
    memberDb = user.db;
    const r = await createOrg(user.db, "Förberedarna");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data, error } = await adminClient()
      .from("prepared_agendas")
      .insert({ org_id: orgId, meeting_date: "2026-12-01", kind: "veckomote", doc_id: "doc-prepared-1", tab_id: "t.0", doc_name: "2026-12-01 Dagordning – Förberedarna" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = data.id as string;
  });

  it("one per förening and date; members read it, writes are the service role's", async () => {
    const dup = await adminClient().from("prepared_agendas").insert({ org_id: orgId, meeting_date: "2026-12-01", kind: "arsmote", doc_id: "d2", tab_id: "t.0", doc_name: "x" });
    expect(dup.error?.code).toBe("23505");
    expect((await preparedForDate(orgId, "2026-12-01", memberDb))?.id).toBe(id);
    const write = await memberDb.from("prepared_agendas").update({ doc_name: "hack" }).eq("id", id).select("id");
    expect(write.data ?? []).toEqual([]);
  });

  it("two concurrent updates: exactly one gets the lease; after release (or expiry) the next one does", async () => {
    const [a, b] = await Promise.all([acquireLease(id, T1), acquireLease(id, T2)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const holder = a ? T1 : T2;
    const other = a ? T2 : T1;
    expect(await acquireLease(id, T3)).toBeNull();
    // Only the holder releases.
    expect(await releaseLease(id, other)).toBe(false);
    expect(await releaseLease(id, holder)).toBe(true);
    expect(await acquireLease(id, T1)).not.toBeNull();
    // An expired lease (a crashed or slow request) is taken over; the old holder can no longer release it.
    await adminClient().from("prepared_agendas").update({ busy_until: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
    expect(await acquireLease(id, T2)).not.toBeNull();
    expect(await releaseLease(id, T1)).toBe(false);
    expect(await releaseLease(id, T2)).toBe(true);
  });

  it("format_profiles accepts the Årsmöte kind", async () => {
    const { error } = await adminClient().from("format_profiles").insert({ org_id: orgId, kind: "arsmote", profile: {}, is_default: false });
    expect(error).toBeNull();
  });
});
