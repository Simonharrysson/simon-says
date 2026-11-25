import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { ensureStandardRow } from "@/lib/formats/store";
import { VECKOMOTE } from "@/lib/formats/standard";
import { kindOfSection, sectionOfKind, type NoteSection } from "@/lib/db/types";

const PROFILE = { name: "Test", sections: [] };

describe("section/kind mapping", () => {
  it("round-trips every section", () => {
    const sections: NoteSection[] = ["decision", "action", "now", "attendees", "note"];
    for (const s of sections) expect(sectionOfKind(kindOfSection(s))).toBe(s);
    expect(kindOfSection("action")).toBe("task");
    expect(kindOfSection("attendees")).toBe("attendee");
  });
});

describe.skipIf(!hasLocalSupabase)("meeting formats schema (0023, 0024)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([
      createTestUser("fadmin"),
      createTestUser("fmember"),
      createTestUser("foutsider"),
    ]);
    const r = await createOrg(admin.db, "Formatföreningen");
    const o = await createOrg(outsider.db, "Annan förening");
    if (!r.ok || !o.ok) throw new Error("org setup failed");
    orgId = r.id;
    otherOrgId = o.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("members read the org's format profiles, non-members get nothing", async () => {
    const { error } = await adminClient()
      .from("format_profiles")
      .insert({ org_id: orgId, kind: "enkel", profile: PROFILE });
    expect(error).toBeNull();
    const asMember = await member.db.from("format_profiles").select("id").eq("org_id", orgId);
    expect(asMember.error).toBeNull();
    expect(asMember.data!.length).toBeGreaterThan(0);
    const asOutsider = await outsider.db.from("format_profiles").select("id").eq("org_id", orgId);
    expect(asOutsider.data).toEqual([]);
  });

  it("authenticated users cannot write format_profiles directly", async () => {
    const { error } = await admin.db.from("format_profiles").insert({ org_id: orgId, kind: "enkel", profile: PROFILE });
    expect(error).not.toBeNull();
  });

  it("set_default_format: member denied, admin gets an id, exactly one default", async () => {
    const denied = await member.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "veckomote", p_profile: PROFILE });
    expect(denied.error).not.toBeNull();
    const first = await admin.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "veckomote", p_profile: PROFILE });
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");
    const second = await admin.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "learned", p_profile: PROFILE });
    expect(second.error).toBeNull();
    const { data } = await adminClient().from("format_profiles").select("id, approved_by, is_default").eq("org_id", orgId).eq("is_default", true);
    expect(data).toHaveLength(1);
    expect(data![0]!.id).toBe(second.data);
    expect(data![0]!.approved_by).toBe(admin.id);
    const bad = await admin.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "nonsense", p_profile: PROFILE });
    expect(bad.error).not.toBeNull();
  });

  it("set_default_format_id: moves the default, refuses another org's profile and non-admins", async () => {
    const first = await admin.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "enkel", p_profile: PROFILE });
    const second = await admin.db.rpc("set_default_format", { p_org_id: orgId, p_kind: "enkel", p_profile: PROFILE });
    expect(second.error).toBeNull();
    const back = await admin.db.rpc("set_default_format_id", { p_org_id: orgId, p_profile_id: first.data });
    expect(back.error).toBeNull();
    const { data } = await adminClient().from("format_profiles").select("id").eq("org_id", orgId).eq("is_default", true);
    expect(data!.map((r) => r.id)).toEqual([first.data]);

    const foreign = await outsider.db.rpc("set_default_format", { p_org_id: otherOrgId, p_kind: "enkel", p_profile: PROFILE });
    expect(foreign.error).toBeNull();
    const cross = await admin.db.rpc("set_default_format_id", { p_org_id: orgId, p_profile_id: foreign.data });
    expect(cross.error).not.toBeNull();
    const still = await adminClient().from("format_profiles").select("id").eq("org_id", orgId).eq("is_default", true);
    expect(still.data!.map((r) => r.id)).toEqual([first.data]);
    const byMember = await member.db.rpc("set_default_format_id", { p_org_id: orgId, p_profile_id: first.data });
    expect(byMember.error).not.toBeNull();
  });

  it("an admin can set meeting_folder_id, a member cannot", async () => {
    const ok = await admin.db.from("orgs").update({ meeting_folder_id: "folder1" }).eq("id", orgId).select("id");
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
    const no = await member.db.from("orgs").update({ meeting_folder_id: "x" }).eq("id", orgId).select("id");
    expect(no.data ?? []).toHaveLength(0);
    const { data } = await adminClient().from("orgs").select("meeting_folder_id").eq("id", orgId).single();
    expect(data!.meeting_folder_id).toBe("folder1");
  });

  it("people.role is limited to 1-40 characters", async () => {
    const db = adminClient();
    expect((await db.from("people").insert({ org_id: orgId, name: "Rolf", role: "kassör" })).error).toBeNull();
    expect((await db.from("people").insert({ org_id: orgId, name: "Rut", role: "x".repeat(41) })).error).not.toBeNull();
    expect((await db.from("people").insert({ org_id: orgId, name: "Rune", role: "   " })).error).not.toBeNull();
  });

  it("meetings default to layout v1 and the new flags off", async () => {
    const { meetingId } = await seedMeeting(orgId, admin.id);
    const { data } = await adminClient()
      .from("meetings")
      .select("layout, agenda_doc, is_test, agenda_roles, checkin_window, format_profile_id")
      .eq("id", meetingId)
      .single();
    expect(data).toEqual({
      layout: "v1",
      agenda_doc: false,
      is_test: false,
      agenda_roles: {},
      checkin_window: null,
      format_profile_id: null,
    });
    const bad = await adminClient().from("meetings").update({ layout: "x" }).eq("id", meetingId);
    expect(bad.error).not.toBeNull();
  });

  it("meeting_events keeps every older kind and accepts the new ones", async () => {
    const { meetingId } = await seedMeeting(orgId, admin.id);
    const kinds = [
      "tick_ok", "tick_failed", "tick_conflict", "doc_paused", "reconnect", "consent", "alarm", "started",
      "ended", "abandoned", "resumed", "test_started", "paused", "unpaused", "name_round", "final_without_claude",
      "agenda_anchored", "format_learned", "followup_prefilled", "checkin",
    ];
    for (const kind of kinds) {
      const { error } = await adminClient().from("meeting_events").insert({ meeting_id: meetingId, kind });
      expect(error, kind).toBeNull();
    }
    expect((await adminClient().from("meeting_events").insert({ meeting_id: meetingId, kind: "bogus" })).error).not.toBeNull();
  });

  it("save_note_rows: old row shape and new fields, section 'note'", async () => {
    const { meetingId } = await seedMeeting(orgId, admin.id);
    const db = adminClient();
    const lease = crypto.randomUUID();
    await db.from("meetings").update({ tick_lease_id: lease }).eq("id", meetingId);
    const { data: person } = await db.from("people").insert({ org_id: orgId, name: "Nina" }).select("id").single();
    const prev = crypto.randomUUID();

    const old = await db.rpc("save_note_rows", {
      p_meeting_id: meetingId,
      p_lease_id: lease,
      p_rows: [{ id: "n1", section: "decision", text: "Vi kör", position: 0 }],
    });
    expect(old.error).toBeNull();
    expect(old.data).toBe(true);
    let { data } = await db.from("note_items").select("*").eq("meeting_id", meetingId);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ id: "n1", done: false, kind: null, anchor: null, owner_person_id: null, copy_of: null });

    const next = await db.rpc("save_note_rows", {
      p_meeting_id: meetingId,
      p_lease_id: lease,
      p_rows: [
        {
          id: "n2", section: "note", text: "Anteckning", position: 1, kind: "note", anchor: "ag-1", done: true,
          owner_person_id: person!.id, carried_from_meeting: prev, carried_from_id: "n9", copy_of: "n3",
        },
      ],
    });
    expect(next.error).toBeNull();
    ({ data } = await db.from("note_items").select("*").eq("meeting_id", meetingId));
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      id: "n2", section: "note", kind: "note", anchor: "ag-1", done: true, owner_person_id: person!.id,
      carried_from_meeting: prev, carried_from_id: "n9", copy_of: "n3",
    });
  });

  it("save_note_rows stays server-only", async () => {
    const { error } = await admin.db.rpc("save_note_rows", {
      p_meeting_id: crypto.randomUUID(), p_lease_id: crypto.randomUUID(), p_rows: [],
    });
    expect(error).not.toBeNull();
  });

  it("ensureStandardRow: one non-default row per standard kind, reused, the default untouched (A10)", async () => {
    const db = adminClient();
    const before = await db.from("format_profiles").select("id").eq("org_id", orgId).eq("is_default", true).maybeSingle();
    const a = await ensureStandardRow(orgId, "veckomote", db);
    const b = await ensureStandardRow(orgId, "veckomote", db);
    expect(b).toBe(a);
    const { data } = await db.from("format_profiles").select("kind, is_default, profile").eq("id", a).single();
    expect(data).toMatchObject({ kind: "veckomote", is_default: false });
    expect(data!.profile).toEqual(VECKOMOTE);
    const after = await db.from("format_profiles").select("id").eq("org_id", orgId).eq("is_default", true).maybeSingle();
    expect(after.data?.id).toBe(before.data?.id);
    expect(await ensureStandardRow(otherOrgId, "veckomote", db)).not.toBe(a);
  });

  it("an agenda-mode meetings row and its pre-filled note rows are accepted as A10 writes them", async () => {
    const db = adminClient();
    const profileId = await ensureStandardRow(orgId, "veckomote", db);
    const id = crypto.randomUUID();
    const { error } = await db.from("meetings").insert({
      id, org_id: orgId, started_by: admin.id, doc_id: "agenda-doc-a10", notes_tab_id: "t.0", transcript_tab_id: null,
      header_range: `ss-${id}-header`, header_rendered: "Simon Says antecknar live · uppdaterad –",
      section_ranges: { "ag-1": `ss-${id}-ag-1`, tasks: `ss-${id}-sec-tasks` }, status: "done",
      agenda_doc: true, layout: "format", format_profile_id: profileId, is_test: true,
      agenda_roles: { "ag-1": "followup" }, checkin_window: { startMs: null, endMs: null, closed: false, failures: 0 },
    });
    expect(error).toBeNull();
    const rows = await db.from("note_items").insert([
      { meeting_id: id, id: "info-tid", section: "note", kind: "note", text: "18:05", anchor: "info.tid",
        range_name: `ss-${id}-info-tid`, last_rendered_text: "18:05", position: 0, locked: false, deleted_by_human: false,
        owner: null, due: null, done: false, copy_of: null },
      { meeting_id: id, id: "c1", section: "action", kind: "task", text: "Boka hallen", anchor: "ag-1", owner: null, due: null,
        owner_person_id: null, locked: false, deleted_by_human: false, done: false, carried_from_meeting: crypto.randomUUID(),
        carried_from_id: "n1", copy_of: null, range_name: null, last_rendered_text: null, position: 0 },
    ]);
    expect(rows.error).toBeNull();
    const upd = await db.from("note_items").update({ range_name: `ss-${id}-c1`, last_rendered_text: "– Boka hallen.", position: 1 })
      .eq("meeting_id", id).eq("id", "c1");
    expect(upd.error).toBeNull();
  });
});
