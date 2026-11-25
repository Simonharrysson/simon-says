import { describe, expect, it } from "vitest";
import { createOrg } from "@/lib/db/orgs";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting } from "@/test/local-supabase";

// Fix round A10 (migration 0026, Ruling R-A9): backfill_test_meetings() marks meetings that logged
// 'test_started' or have a test ElevenLabs session as is_test; real meetings stay false; idempotent;
// service role only.

describe.skipIf(!hasLocalSupabase)("backfill_test_meetings (0026)", () => {
  it("marks Testmöten by event or test session, leaves real meetings, second run changes nothing", async () => {
    const admin = adminClient();
    const u = await createTestUser("backfill");
    const r = await createOrg(u.db, `Backfill-${crypto.randomUUID().slice(0, 8)}`);
    if (!r.ok) throw new Error("org");
    const byEvent = await seedMeeting(r.id, u.id);
    const bySession = await seedMeeting(r.id, u.id);
    const real = await seedMeeting(r.id, u.id);
    expect((await admin.from("meeting_events").insert({ meeting_id: byEvent.meetingId, kind: "test_started" })).error).toBeNull();
    expect((await admin.from("el_sessions").update({ kind: "test" }).eq("id", bySession.sessionId)).error).toBeNull();

    const first = await admin.rpc("backfill_test_meetings");
    expect(first.error).toBeNull();
    expect(first.data).toBeGreaterThanOrEqual(2);
    const { data } = await admin
      .from("meetings")
      .select("id, is_test")
      .in("id", [byEvent.meetingId, bySession.meetingId, real.meetingId]);
    const flag = Object.fromEntries((data ?? []).map((m) => [m.id, m.is_test]));
    expect(flag).toEqual({ [byEvent.meetingId]: true, [bySession.meetingId]: true, [real.meetingId]: false });

    // Again: no error, nothing of ours changes (other test files may add test sessions meanwhile).
    expect((await admin.rpc("backfill_test_meetings")).error).toBeNull();
    const again = await admin.from("meetings").select("is_test").eq("id", real.meetingId).single();
    expect(again.data?.is_test).toBe(false);
    expect((await u.db.rpc("backfill_test_meetings")).error).not.toBeNull();
  });
});
