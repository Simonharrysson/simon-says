import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import type { DashInput } from "@/lib/dashboard/overview";

// "Mål att ta upp" (todo #12), as a feature: the förening's approved goals → Förbered möte's draft
// suggests at most two, each with a one-line reason → the ordförande ticks one → it is a topic on
// the agenda and in the Doc as "Mål: <titel>"; the reason and the unticked goal never reach the
// Doc. Deterministic, no Claude call. Fictional förening and goals.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));

const { goalMeetings, suggestGoals } = await import("@/lib/prepare/goals");
const { buildDraft, normaliseItems, agendaItems } = await import("@/lib/prepare/draft");
const { skeletonBlocks } = await import("@/lib/formats/skeleton");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { loadDraft } = await import("@/lib/prepare/prepare");
const { createOrg, joinOrg } = await import("@/lib/db/orgs");
const { chooseStandardFormat } = await import("@/lib/formats/store");

const NOW = new Date("2026-11-26T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ctx = { profile: VECKOMOTE, ownerLabel: (o: string) => o };

const GOALS = [
  { id: "g1", title: "Fler medlemmar till vårens event", approved_at: day(90) },
  { id: "g2", title: "Ny lokal för styrelsen", approved_at: day(90) },
  { id: "g3", title: "Balanserad budget", approved_at: day(90) },
];

function overview(): DashInput {
  const base = { owner: null, due: null, done: false, deleted_by_human: false, copy_of: null, carried_from_meeting: null, carried_from_id: null, position: 0 };
  const m = (id: string, at: string, label: string) => ({ id, org_id: "o", started_at: at, status: "done" as const, layout: "format" as const, agenda_labels: { "ag-1": label }, agenda_roles: { "ag-1": "topic" as const } });
  return {
    meetings: [m("m1", day(50), "Medlemsvärvning"), m("m2", day(25), "Budgeten"), m("m3", day(6), "Lokalen")],
    items: [
      { ...base, meeting_id: "m1", id: "a", section: "action", kind: "task", text: "Affischer om vårens event för nya medlemmar", anchor: "ag-1" },
      { ...base, meeting_id: "m2", id: "b", section: "decision", kind: "decision", text: "Budgeten ska vara balanserad till jul", anchor: "ag-1" },
      { ...base, meeting_id: "m3", id: "c", section: "decision", kind: "decision", text: "Att ansöka om ny lokal för styrelsen hos kåren", anchor: "ag-1" },
    ],
    speakers: [],
    people: [],
  };
}

describe("feature: chain (Mål att ta upp: goals suggested when preparing a meeting)", () => {
  it("two goals with reasons; the ticked one is a topic in the Doc, the reason and the other goal are not", () => {
    const goals = suggestGoals(GOALS, goalMeetings("o", overview()), NOW);
    expect(goals.map((g) => [g.title, g.reason])).toEqual([
      ["Ny lokal för styrelsen", "Följ upp beslutet från förra veckan"],
      ["Fler medlemmar till vårens event", "Inget nytt sedan 7 okt"],
    ]);
    const draft = buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [], goals });
    const suggested = draft.filter((i) => i.id.startsWith("goal:"));
    expect(suggested.every((i) => !i.on && i.role === "topic")).toBe(true);

    // The ordförande ticks "Ny lokal" ("Lägg till"); the browser sends ids, labels and ticks only.
    const body = draft.map((i) => ({ id: i.id, label: i.label, source: i.source, on: i.id === "goal:ny lokal för styrelsen" || i.on }));
    const items = normaliseItems(body, draft)!;
    const lines = skeletonBlocks(VECKOMOTE, { items: agendaItems(items).map((i) => ({ label: i.label })) }).map((b) => ("text" in b ? b.text : ""));
    expect(lines).toContain("Mål: Ny lokal för styrelsen");
    expect(lines.indexOf("Mål: Ny lokal för styrelsen")).toBeLessThan(lines.indexOf("Övrigt"));
    expect(lines.join("\n")).not.toMatch(/Följ upp beslutet|Inget nytt|Fler medlemmar/);
    expect(items.find((i) => i.id === "goal:ny lokal för styrelsen")).toEqual({ id: "goal:ny lokal för styrelsen", label: "Mål: Ny lokal för styrelsen", role: "topic", source: "suggested", on: true });
  });
});

describe.skipIf(!hasLocalSupabase)("feature: chain (Mål att ta upp on the local stack: org_goals → loadDraft)", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("goal-adm"), createTestUser("goal-mem")]);
    const r = await createOrg(admin.db, "Målföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    await joinOrg(member.db, data!.invite_code as string);
    await chooseStandardFormat(admin.db, orgId, "veckomote");
    const svc = adminClient();
    // A meeting 5 weeks ago about the event, one last week deciding on the lokal.
    for (const [days, label, text] of [
      [35, "Medlemsvärvning", "Affischer om vårens event för nya medlemmar"],
      [6, "Lokalen", "Att ansöka om ny lokal för styrelsen hos kåren"],
    ] as const) {
      const { meetingId } = await seedMeeting(orgId, admin.id);
      await svc
        .from("meetings")
        .update({ started_at: new Date(Date.now() - days * 86_400_000).toISOString(), layout: "format", agenda_roles: { "ag-1": "topic" }, agenda_labels: { "ag-1": label } })
        .eq("id", meetingId);
      await svc.from("note_items").insert({ meeting_id: meetingId, id: "d1", section: "decision", kind: "decision", text, anchor: "ag-1" });
    }
  });

  it("the draft suggests the approved goals with reasons; a goal no longer approved never comes back", async () => {
    // Approved 60 days ago (backdated: set_org_goals stamps now()).
    await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: [{ title: "Fler medlemmar till vårens event" }, { title: "Ny lokal för styrelsen" }, { title: "Balanserad budget" }] });
    await adminClient().from("org_goals").update({ approved_at: new Date(Date.now() - 60 * 86_400_000).toISOString() }).eq("org_id", orgId);
    const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const res = await loadDraft(member.db, orgId, "veckomote", date);
    if (!res.ok) throw new Error(res.error);
    const goals = res.draft.items.filter((i) => i.id.startsWith("goal:"));
    expect(goals.map((g) => [g.label, g.on, g.reason])).toEqual([
      ["Mål: Ny lokal för styrelsen", false, "Följ upp beslutet från förra veckan"],
      // Both quiet; the one set 60 days ago and never mentioned is quieter than the event (35 days).
      ["Mål: Balanserad budget", false, expect.stringMatching(/^Inget nytt sedan /)],
    ]);

    // The admin drops "Ny lokal" (achieved): it is never suggested again.
    await admin.db.rpc("set_org_goals", { p_org_id: orgId, p_goals: [{ title: "Fler medlemmar till vårens event" }, { title: "Balanserad budget" }] });
    const again = await loadDraft(member.db, orgId, "veckomote", date);
    if (!again.ok) throw new Error(again.error);
    expect(again.draft.items.some((i) => i.label === "Mål: Ny lokal för styrelsen")).toBe(false);
  });
});
