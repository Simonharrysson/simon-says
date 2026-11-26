import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// 0033: prepared_agendas — one per förening and date, members read, and the lease that keeps two
// "Skapa dagordning" on the same agenda from planning from the same state.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
const { acquireLease, releaseLease, preparedForDate } = await import("@/lib/prepare/store");

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
    const [a, b] = await Promise.all([acquireLease(id), acquireLease(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(id)).toBeNull();
    await releaseLease(id);
    expect(await acquireLease(id)).not.toBeNull();
    // An expired lease (a crashed request) is taken over.
    await adminClient().from("prepared_agendas").update({ busy_until: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
    expect(await acquireLease(id)).not.toBeNull();
    await releaseLease(id);
  });

  it("format_profiles accepts the Årsmöte kind", async () => {
    const { error } = await adminClient().from("format_profiles").insert({ org_id: orgId, kind: "arsmote", profile: {}, is_default: false });
    expect(error).toBeNull();
  });
});
