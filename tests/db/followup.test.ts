import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";
import type { NoteItemRow } from "@/lib/db/types";
import { previousMeeting, propagateDone } from "@/lib/agenda/followup";

describe.skipIf(!hasLocalSupabase)("followup (db)", () => {
  let orgId: string;
  let userId: string;
  let real: string;
  let test: string;
  let live: string;

  beforeAll(async () => {
    const u = await createTestUser("fuadmin");
    userId = u.id;
    const r = await createOrg(u.db, "Uppföljningsföreningen");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const db = adminClient();
    real = (await seedMeeting(orgId, userId, "done")).meetingId;
    test = (await seedMeeting(orgId, userId, "done")).meetingId;
    live = (await seedMeeting(orgId, userId, "live")).meetingId;
    await db.from("meetings").update({ started_at: "2026-01-01T10:00:00Z" }).eq("id", real);
    await db.from("meetings").update({ started_at: "2026-02-01T10:00:00Z", is_test: true }).eq("id", test);
    await db.from("meetings").update({ started_at: "2026-03-01T10:00:00Z" }).eq("id", live);
    await db.from("note_items").insert({ meeting_id: real, id: "n4", section: "action", text: "Boka lokal" });
  });

  const now = new Date("2026-04-01T00:00:00Z");

  it("picks the latest done meeting with the same is_test, never a live one", async () => {
    expect((await previousMeeting(orgId, false, now, adminClient()))?.id).toBe(real);
    expect((await previousMeeting(orgId, true, now, adminClient()))?.id).toBe(test);
    expect(await previousMeeting(orgId, false, new Date("2025-01-01T00:00:00Z"), adminClient())).toBeNull();
  });

  it("propagates done once to the source row", async () => {
    const carried = {
      meeting_id: "x",
      id: "c1",
      section: "action",
      text: "ändrad text",
      done: true,
      carried_from_meeting: real,
      carried_from_id: "n4",
    } as NoteItemRow;
    expect(await propagateDone([carried], adminClient())).toBe(1);
    const { data } = await adminClient().from("note_items").select("done, text").eq("meeting_id", real).eq("id", "n4").single();
    expect(data).toEqual({ done: true, text: "Boka lokal" });
    expect(await propagateDone([carried], adminClient())).toBe(0);
    expect(await propagateDone([{ ...carried, done: false }], adminClient())).toBe(0);
  });
});
