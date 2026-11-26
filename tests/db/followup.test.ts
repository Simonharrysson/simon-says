import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  createTestUser,
  hasLocalSupabase,
  seedMeeting,
} from "@/test/local-supabase";
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
    await db
      .from("meetings")
      .update({ started_at: "2026-01-01T10:00:00Z" })
      .eq("id", real);
    await db
      .from("meetings")
      .update({ started_at: "2026-02-01T10:00:00Z", is_test: true })
      .eq("id", test);
    await db
      .from("meetings")
      .update({ started_at: "2026-03-01T10:00:00Z" })
      .eq("id", live);
    await db
      .from("note_items")
      .insert({
        meeting_id: real,
        id: "n4",
        section: "action",
        text: "Boka lokal",
      });
  });

  const now = new Date("2026-04-01T00:00:00Z");

  it("picks the latest done meeting with the same is_test, never a live one", async () => {
    expect((await previousMeeting(orgId, false, now, adminClient()))?.id).toBe(
      real,
    );
    expect((await previousMeeting(orgId, true, now, adminClient()))?.id).toBe(
      test,
    );
    expect(
      await previousMeeting(
        orgId,
        false,
        new Date("2025-01-01T00:00:00Z"),
        adminClient(),
      ),
    ).toBeNull();
  });

  it("an agenda Testmöte picks only agenda Testmöten; real meetings ignore agenda_doc (A13)", async () => {
    const db = adminClient();
    const agendaTest = (await seedMeeting(orgId, userId, "done")).meetingId;
    await db
      .from("meetings")
      .update({ started_at: "2026-01-15T10:00:00Z", is_test: true, agenda_doc: true })
      .eq("id", agendaTest);
    // `test` (2026-02-01) is newer but not an agenda Testmöte.
    expect((await previousMeeting(orgId, true, now, db, true))?.id).toBe(agendaTest);
    expect((await previousMeeting(orgId, true, now, db, false))?.id).toBe(test);
    expect((await previousMeeting(orgId, true, now, db))?.id).toBe(test);
    expect((await previousMeeting(orgId, false, now, db, true))?.id).toBe(real);
    await db.from("meetings").delete().eq("id", agendaTest);
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
    expect(await propagateDone([carried], orgId, false, adminClient())).toBe(1);
    const { data } = await adminClient()
      .from("note_items")
      .select("done, text")
      .eq("meeting_id", real)
      .eq("id", "n4")
      .single();
    expect(data).toEqual({ done: true, text: "Boka lokal" });
    expect(await propagateDone([carried], orgId, false, adminClient())).toBe(0);
    expect(
      await propagateDone(
        [{ ...carried, done: false }],
        orgId,
        false,
        adminClient(),
      ),
    ).toBe(0);
  });

  it("never touches a source meeting of another org or other is_test", async () => {
    const o = await createTestUser("fuother");
    const r2 = await createOrg(o.db, "Annan uppföljning");
    if (!r2.ok) throw new Error("org setup failed");
    const foreign = (await seedMeeting(r2.id, o.id, "done")).meetingId;
    await adminClient()
      .from("note_items")
      .insert({
        meeting_id: foreign,
        id: "n7",
        section: "action",
        text: "Annans",
      });
    const carried = {
      meeting_id: "x",
      id: "c1",
      section: "action",
      text: "t",
      done: true,
      carried_from_meeting: foreign,
      carried_from_id: "n7",
    } as NoteItemRow;
    expect(await propagateDone([carried], orgId, false, adminClient())).toBe(0);
    const { data } = await adminClient()
      .from("note_items")
      .select("done")
      .eq("meeting_id", foreign)
      .eq("id", "n7")
      .single();
    expect(data!.done).toBe(false);
    const own = {
      ...carried,
      carried_from_meeting: real,
      carried_from_id: "n4",
    };
    expect(await propagateDone([own], orgId, true, adminClient())).toBe(0);
  });

  it("follows the carried chain to the root: week 3 closing a task carried 1 → 2 → 3 closes weeks 2 and 1", async () => {
    const db = adminClient();
    const w1 = (await seedMeeting(orgId, userId, "done")).meetingId;
    const w2 = (await seedMeeting(orgId, userId, "done")).meetingId;
    const o = await createTestUser("fuchain");
    const r2 = await createOrg(o.db, "Annan kedja");
    if (!r2.ok) throw new Error("org setup failed");
    const foreign = (await seedMeeting(r2.id, o.id, "done")).meetingId;
    const { error } = await db.from("note_items").insert([
      { meeting_id: foreign, id: "n9", section: "action", text: "Annans" },
      { meeting_id: w1, id: "n2", section: "action", kind: "task", text: "Skicka kallelsen", carried_from_meeting: foreign, carried_from_id: "n9" },
      { meeting_id: w2, id: "c1", section: "action", kind: "task", text: "Skicka kallelsen", carried_from_meeting: w1, carried_from_id: "n2" },
    ]);
    if (error) throw new Error(error.message);
    const w3c1 = {
      meeting_id: "w3",
      id: "c1",
      section: "action",
      text: "Skicka kallelsen",
      done: true,
      carried_from_meeting: w2,
      carried_from_id: "c1",
    } as NoteItemRow;
    expect(await propagateDone([w3c1], orgId, false, db)).toBe(2);
    const done = async (m: string, id: string) => (await db.from("note_items").select("done").eq("meeting_id", m).eq("id", id).single()).data!.done;
    expect(await done(w2, "c1")).toBe(true);
    expect(await done(w1, "n2")).toBe(true);
    // The chain stops at another org's meeting.
    expect(await done(foreign, "n9")).toBe(false);
    expect(await propagateDone([w3c1], orgId, false, db)).toBe(0);
  });
});
