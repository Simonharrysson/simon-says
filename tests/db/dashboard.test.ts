import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { loadOverview, listGoals } from "@/lib/dashboard/load";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// Org dashboard schema (0028) and the loader against the local stack. Fictional data only.

describe.skipIf(!hasLocalSupabase)("org dashboard (0028)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([createTestUser("dadmin"), createTestUser("dmember"), createTestUser("doutsider")]);
    const r = await createOrg(admin.db, "Tärningen");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("set_org_goals: admin replaces the set, member denied, more than 5 refused", async () => {
    const goals = [{ title: "Fler medlemmar", why: "Värvning återkommer." }, { title: "En spelkväll i månaden" }];
    const ok = await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: goals });
    expect(ok.error).toBeNull();
    expect(ok.data).toBe(2);
    const again = await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: [{ title: "Bara ett mål" }] });
    expect(again.data).toBe(1);
    const read = await listGoals(member.db, orgId);
    expect(read.map((g) => [g.title, g.why])).toEqual([["Bara ett mål", null]]);

    const denied = await member.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: [] });
    expect(denied.error?.code).toBe("42501");
    const tooMany = await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: Array.from({ length: 6 }, () => ({ title: "x" })) });
    expect(tooMany.error).not.toBeNull();
    const noTitle = await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: [{ why: "x" }] });
    expect(noTitle.error).not.toBeNull();
    // A refused call changed nothing.
    expect((await listGoals(admin.db, orgId)).map((g) => g.title)).toEqual(["Bara ett mål"]);
  });

  it("org_goals: outsiders read nothing, nobody writes the table directly", async () => {
    expect(await listGoals(outsider.db, orgId)).toEqual([]);
    const ins = await admin.db.from("org_goals").insert({ org_id: orgId, position: 7, title: "Direkt" });
    expect(ins.error).not.toBeNull();
    const del = await admin.db.from("org_goals").delete().eq("org_id", orgId).select("id");
    expect(del.data ?? []).toEqual([]);
    expect(await listGoals(member.db, orgId)).toHaveLength(1);
  });

  it("claim_goal_proposal: admins only, 3 per 24 h, the table is closed to users", async () => {
    const denied = await member.db.rpc("claim_goal_proposal", { p_org_id: orgId });
    expect(denied.error?.code).toBe("42501");
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) results.push((await admin.db.rpc("claim_goal_proposal", { p_org_id: orgId })).data);
    expect(results).toEqual([true, true, true, false]);
    const asAdmin = await admin.db.from("goal_proposals").select("id").eq("org_id", orgId);
    expect(asAdmin.error).not.toBeNull();
    // Older than 24 h no longer counts.
    await adminClient().from("goal_proposals").update({ at: new Date(Date.now() - 25 * 3600_000).toISOString() }).eq("org_id", orgId);
    expect((await admin.db.rpc("claim_goal_proposal", { p_org_id: orgId })).data).toBe(true);
  });

  it("merge_agenda_labels: service role only, merges keys", async () => {
    const { meetingId } = await seedMeeting(orgId, admin.id);
    const denied = await admin.db.rpc("merge_agenda_labels", { p_meeting_id: meetingId, p_labels: { "ag-1": "x" } });
    expect(denied.error).not.toBeNull();
    const svc = adminClient();
    expect((await svc.rpc("merge_agenda_labels", { p_meeting_id: meetingId, p_labels: { "ag-1": "Ekonomi" } })).data).toBe(true);
    expect((await svc.rpc("merge_agenda_labels", { p_meeting_id: meetingId, p_labels: { "ag-2": "Spelkväll" } })).data).toBe(true);
    const { data } = await member.db.from("meetings").select("agenda_labels").eq("id", meetingId).single();
    expect(data!.agenda_labels).toEqual({ "ag-1": "Ekonomi", "ag-2": "Spelkväll" });
    await svc.from("meetings").delete().eq("id", meetingId);
  });

  it("loadOverview: members see the org's real ended meetings; Testmöten, live meetings and outsiders get nothing", async () => {
    const svc = adminClient();
    const { data: person } = await svc.from("people").insert({ org_id: orgId, name: "Ada Kask" }).select("id").single();
    const seeded: string[] = [];
    for (const [date, test] of [["2026-10-01", false], ["2026-10-29", false], ["2026-11-05", true]] as const) {
      const { meetingId, sessionId } = await seedMeeting(orgId, admin.id);
      seeded.push(meetingId);
      await svc
        .from("meetings")
        .update({ started_at: `${date}T17:00:00Z`, is_test: test, layout: "format", agenda_roles: { "ag-1": "topic" }, agenda_labels: { "ag-1": "Ekonomi" } })
        .eq("id", meetingId);
      await svc.from("speaker_map").update({ person_id: person!.id }).eq("meeting_id", meetingId).eq("el_session_id", sessionId);
      const items = [
        { meeting_id: meetingId, id: "d1", section: "decision", kind: "decision", text: test ? "Testbeslut" : `Beslut ${date}`, anchor: "ag-1" },
        { meeting_id: meetingId, id: "t1", section: "action", kind: "task", text: test ? "Testuppgift" : `Uppgift ${date}`, owner_person_id: person!.id },
        { meeting_id: meetingId, id: "x1", section: "note", kind: "note", text: "En anteckning" },
      ];
      const { error } = await svc.from("note_items").insert(items);
      expect(error).toBeNull();
    }
    const live = await seedMeeting(orgId, admin.id, "live");
    await svc.from("note_items").insert({ meeting_id: live.meetingId, id: "d9", section: "decision", kind: "decision", text: "Pågår" });

    const o = await loadOverview(member.db, orgId, new Date("2026-11-26T18:00:00Z"));
    const texts = o.decisions.map((d) => d.text);
    expect(texts).toContain("Beslut 2026-10-29");
    expect(texts).toContain("Beslut 2026-10-01");
    expect(texts.some((t) => /Test|Pågår|anteckning/.test(t))).toBe(false);
    expect(o.decisions.find((d) => d.text === "Beslut 2026-10-29")!.item).toBe("Ekonomi");
    expect(o.topics.map((t) => [t.label, t.meetings])).toEqual([["Ekonomi", 2]]);
    const tasks = o.openTasks.flatMap((g) => g.tasks.map((t) => t.text));
    expect(tasks).toEqual(expect.arrayContaining(["Uppgift 2026-10-01", "Uppgift 2026-10-29"]));
    expect(tasks).not.toContain("Testuppgift");
    expect(o.attendance.people.find((p) => p.name === "Ada Kask")!.attended).toBe(2);

    const none = await loadOverview(outsider.db, orgId);
    expect(none.meetingCount).toBe(0);
    expect(none.decisions).toEqual([]);

    await svc.from("meetings").delete().in("id", [...seeded, live.meetingId]);
  });
});
