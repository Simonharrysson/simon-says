import { describe, expect, it } from "vitest";
import type { DashInput } from "@/lib/dashboard/overview";
import { goalMeetings, goalStems, mentions, suggestGoals, type GoalMeeting, type GoalRow } from "./goals";

// "Mål att ta upp" (todo #12): the selection rule. Fictional förening and goals.

const NOW = new Date("2026-11-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
const goal = (id: string, title: string, approvedDaysAgo = 90): GoalRow => ({ id, title, approved_at: daysAgo(approvedDaysAgo) });
const meeting = (days: number, texts: string[] = [], decisions: string[] = []): GoalMeeting => ({ at: daysAgo(days), texts, decisions });

const MEMBERS = goal("g1", "Fler medlemmar till vårens event");
const LOKAL = goal("g2", "Ny lokal för styrelsen");
const BUDGET = goal("g3", "Balanserad budget");

describe("goalStems / mentions", () => {
  it("significant words as 5-letter stems; inflections match", () => {
    expect(goalStems("Fler medlemmar till vårens event")).toEqual(["medle", "våren", "event"]);
    expect(mentions(goalStems(MEMBERS.title), "Medlemsvärvning inför eventet")).toBe(true);
    expect(mentions(goalStems(MEMBERS.title), "Ett nytt event i aulan")).toBe(false);
    // A one-word goal needs that word only.
    expect(mentions(goalStems("Sponsorer"), "Ring sponsorerna")).toBe(true);
    expect(mentions([], "vad som helst")).toBe(false);
  });
});

describe("suggestGoals", () => {
  it("a goal quiet for 4+ weeks while the förening met: 'Inget nytt sedan <date>' (last mention)", () => {
    const meetings = [meeting(40, ["Medlemmar till vårens event"]), meeting(14, ["Kassan"]), meeting(7, ["Kassan"])];
    expect(suggestGoals([MEMBERS], meetings, NOW)).toEqual([{ goalId: "g1", title: MEMBERS.title, kind: "quiet", reason: "Inget nytt sedan 17 okt" }]);
  });

  it("never mentioned: quiet since the goal was set", () => {
    const g = goal("g1", MEMBERS.title, 45);
    expect(suggestGoals([g], [meeting(10, ["Kassan"])], NOW)[0].reason).toBe("Inget nytt sedan 12 okt");
  });

  it("not quiet: mentioned within 4 weeks, or no meeting since (nothing to say)", () => {
    expect(suggestGoals([MEMBERS], [meeting(20, ["Medlemmar till eventet i vår"])], NOW)).toEqual([]);
    expect(suggestGoals([MEMBERS], [meeting(60, ["Medlemmar till vårens event"])], NOW)).toEqual([]);
    expect(suggestGoals([goal("g1", MEMBERS.title, 10)], [meeting(5)], NOW)).toEqual([]);
  });

  it("a recent decision: 'Följ upp beslutet från förra veckan', or its date when older", () => {
    expect(suggestGoals([LOKAL], [meeting(7, [], ["Att boka en ny lokal åt styrelsen"])], NOW)[0]).toMatchObject({
      kind: "decision",
      reason: "Följ upp beslutet från förra veckan",
    });
    expect(suggestGoals([LOKAL], [meeting(18, [], ["Styrelsen tittar på lokalen i Kårhuset"])], NOW)[0].reason).toBe("Följ upp beslutet från 8 nov");
    // Older than 3 weeks and quiet since: a quiet goal instead.
    expect(suggestGoals([LOKAL], [meeting(35, [], ["Styrelsen söker ny lokal"]), meeting(3)], NOW)[0].kind).toBe("quiet");
  });

  it("at most two; decisions first, then the longest-quiet; ties in the goals' own order", () => {
    const goals = [MEMBERS, LOKAL, BUDGET, goal("g4", "Sponsorer")];
    const meetings = [meeting(60, ["Budgeten balanseras"]), meeting(50, ["Sponsorer"]), meeting(6, ["Kassan"], ["Lokalen för styrelsen bokas"])];
    const out = suggestGoals(goals, meetings, NOW);
    expect(out.map((g) => [g.goalId, g.kind])).toEqual([
      ["g2", "decision"],
      // g1 never mentioned (set 90 days ago) is quieter than g3 (60) and g4 (50).
      ["g1", "quiet"],
    ]);
    // Same input, same answer.
    expect(suggestGoals(goals, meetings, NOW)).toEqual(out);
    const tie = suggestGoals([goal("a", "Sponsorer"), goal("b", "Alumnnätverk")], [meeting(3)], NOW);
    expect(tie.map((g) => g.goalId)).toEqual(["a", "b"]);
  });

  it("no goals → nothing; meetings after `now` are ignored", () => {
    expect(suggestGoals([], [meeting(3)], NOW)).toEqual([]);
    expect(suggestGoals([LOKAL], [meeting(-2, [], ["Ny lokal för styrelsen"])], NOW)).toEqual([]);
  });
});

describe("goalMeetings", () => {
  it("counted meetings only; labels, decisions and tasks; Må-runda and deleted rows left out", () => {
    const base = { section: "action" as const, owner: null, due: null, done: false, deleted_by_human: false, copy_of: null, carried_from_meeting: null, carried_from_id: null, position: 0 };
    const input: DashInput = {
      meetings: [
        { id: "m1", org_id: "o", started_at: daysAgo(10), status: "done", agenda_labels: { "ag-1": "Må-runda", "ag-2": "Lokalen" }, agenda_roles: { "ag-1": "checkin", "ag-2": "topic" } },
        { id: "t1", org_id: "o", started_at: daysAgo(5), status: "done", is_test: true },
      ],
      items: [
        { ...base, meeting_id: "m1", id: "a", kind: "decision", section: "decision" as const, text: "Ny lokal för styrelsen", anchor: "ag-2" },
        { ...base, meeting_id: "m1", id: "b", kind: "task", text: "Ring om lokalen", anchor: "ag-2" },
        { ...base, meeting_id: "m1", id: "c", kind: "task", text: "Mår bra", anchor: "ag-1" },
        { ...base, meeting_id: "m1", id: "d", kind: "task", text: "Raderad", anchor: "ag-2", deleted_by_human: true },
        { ...base, meeting_id: "t1", id: "e", kind: "decision", section: "decision" as const, text: "Test", anchor: null },
      ],
      speakers: [],
      people: [],
    };
    expect(goalMeetings("o", input)).toEqual([{ at: daysAgo(10), texts: ["Lokalen", "Ring om lokalen"], decisions: ["Ny lokal för styrelsen"] }]);
  });
});

describe("withGoalItems (Starta möte, a new Doc)", () => {
  it("ticked goals become topic items before Övriga punkter; the stored profile is untouched", async () => {
    const { VECKOMOTE } = await import("@/lib/formats/standard");
    const { rolesFromSkeleton, skeletonBlocks } = await import("@/lib/formats/skeleton");
    const { withGoalItems } = await import("./goals");
    const p = withGoalItems(VECKOMOTE, ["Ny lokal för styrelsen", "Ny lokal för styrelsen"]);
    expect(VECKOMOTE.fixedAgendaItems.some((i) => i.key.startsWith("goal-"))).toBe(false);
    const items = skeletonBlocks(p).filter((b) => b.type === "item").map((b) => ("text" in b ? b.text : ""));
    expect(items.filter((t) => t === "Mål: Ny lokal för styrelsen")).toHaveLength(1);
    expect(items.indexOf("Mål: Ny lokal för styrelsen")).toBe(items.indexOf("Övriga punkter") - 1);
    const roles = rolesFromSkeleton(p);
    expect(roles[`ag-${items.indexOf("Mål: Ny lokal för styrelsen") + 1}`]).toBe("topic");
    expect(withGoalItems(VECKOMOTE, [])).toBe(VECKOMOTE);
  });
});
