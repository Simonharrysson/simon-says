import { describe, expect, it } from "vitest";
import { attendance, buildOverview, countedMeetings, openTasks, recentDecisions, recurringTopics, type DashInput, type DashItem, type DashMeeting } from "./overview";

// Fictional förening: "Brädspelsföreningen Tärningen". No real people or content.

const ORG = "org-1";
const NOW = new Date("2026-11-26T18:00:00Z");

const meeting = (id: string, date: string, over: Partial<DashMeeting> = {}): DashMeeting => ({
  id,
  org_id: ORG,
  started_at: `${date}T17:00:00Z`,
  status: "done",
  is_test: false,
  layout: "format",
  agenda_roles: { "ag-1": "checkin", "ag-2": "topic", "ag-3": "topic", "ag-4": "other" },
  agenda_labels: { "ag-1": "Må-runda", "ag-2": "Ekonomi", "ag-3": "Spelkväll", "ag-4": "Övrigt" },
  ...over,
});

let pos = 0;
const item = (meeting_id: string, id: string, over: Partial<DashItem> = {}): DashItem => ({
  meeting_id,
  id,
  section: "action",
  kind: "task",
  text: `Uppgift ${id}`,
  owner: null,
  owner_person_id: null,
  due: null,
  done: false,
  deleted_by_human: false,
  copy_of: null,
  carried_from_meeting: null,
  carried_from_id: null,
  anchor: "ag-2",
  position: pos++,
  ...over,
});
const decision = (meeting_id: string, id: string, text: string, anchor = "ag-2"): DashItem =>
  item(meeting_id, id, { section: "decision", kind: "decision", text, anchor });

const people = [
  { id: "p-ada", name: "Ada Kask", role: "Kassör" },
  { id: "p-bo", name: "Bo Tärn", role: null },
  { id: "p-cid", name: "Cid Ört", role: null },
];

function input(over: Partial<DashInput> = {}): DashInput {
  return {
    meetings: [meeting("m1", "2026-10-01"), meeting("m2", "2026-10-29"), meeting("m3", "2026-11-19")],
    items: [],
    speakers: [],
    people,
    ...over,
  };
}

describe("countedMeetings", () => {
  it("only the org's ended real meetings, oldest first", () => {
    const ms = [
      meeting("b", "2026-11-02"),
      meeting("a", "2026-11-01"),
      meeting("t", "2026-11-03", { is_test: true }),
      meeting("l", "2026-11-04", { status: "live" }),
      meeting("e", "2026-11-05", { status: "ending" }),
      meeting("x", "2026-11-06", { org_id: "other" }),
      meeting("ab", "2026-11-07", { status: "abandoned" }),
    ];
    expect(countedMeetings(ORG, ms).map((m) => m.id)).toEqual(["a", "b", "ab"]);
  });
});

describe("openTasks", () => {
  it("one row per carry chain (its tip), weeks since first written, grouped by person, oldest first", () => {
    const items = [
      item("m1", "n1", { text: "Boka lokal för spelkvällen", owner_person_id: "p-ada", owner: "Ada" }),
      item("m2", "c1", { text: "Boka lokal för spelkvällen", owner_person_id: "p-ada", carried_from_meeting: "m1", carried_from_id: "n1", anchor: null }),
      item("m3", "c2", { text: "Boka lokal för spelkvällen", owner_person_id: "p-ada", carried_from_meeting: "m2", carried_from_id: "c1", anchor: null }),
      item("m3", "n2", { text: "Köp nya tärningar", owner_person_id: "p-bo" }),
      item("m2", "n3", { text: "Skriv nyhetsbrev", owner: "Sekreteraren" }),
      item("m3", "n4", { text: "Fixa affisch" }),
    ];
    const groups = openTasks(ORG, input({ items }), NOW);
    expect(groups.map((g) => [g.label, g.role, g.tasks.map((t) => [t.text, t.weeks])])).toEqual([
      ["Ada Kask", "Kassör", [["Boka lokal för spelkvällen", 8]]],
      ["Sekreteraren", null, [["Skriv nyhetsbrev", 4]]],
      ["Bo Tärn", null, [["Köp nya tärningar", 1]]],
      ["Utan ansvarig", null, [["Fixa affisch", 1]]],
    ]);
    // The agenda item where it was first written.
    expect(groups[0].tasks[0].item).toBe("Ekonomi");
    expect(groups[0].tasks[0].since).toBe("2026-10-01T17:00:00Z");
  });

  it("done on the row, done on its tasks copy, done later in the chain, deleted, or a copy: not open", () => {
    const items = [
      item("m1", "n1", { done: true }),
      item("m1", "n2"),
      item("m1", "n2-t", { copy_of: "n2", done: true }),
      item("m1", "n3"),
      item("m2", "c3", { carried_from_meeting: "m1", carried_from_id: "n3", done: true }),
      item("m2", "n4", { deleted_by_human: true }),
      item("m2", "n5"),
      item("m2", "n5-t", { copy_of: "n5" }),
    ];
    const groups = openTasks(ORG, input({ items }), NOW);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.key))).toEqual(["m2:n5"]);
  });

  it("a carried line a human deleted closes the task (the source is not a tip)", () => {
    const items = [item("m1", "n1"), item("m2", "c1", { carried_from_meeting: "m1", carried_from_id: "n1", deleted_by_human: true })];
    expect(openTasks(ORG, input({ items }), NOW)).toEqual([]);
  });

  it("abandoned false starts and v1-layout meetings never hold open tasks", () => {
    const meetings = [...input().meetings, meeting("ab", "2026-11-20", { status: "abandoned" }), meeting("v1", "2026-11-21", { layout: "v1" })];
    const items = [item("ab", "n1"), item("v1", "n2"), item("m3", "n3")];
    expect(openTasks(ORG, input({ meetings, items }), NOW).flatMap((g) => g.tasks.map((t) => t.key))).toEqual(["m3:n3"]);
  });

  it("Testmöten and Må-runda items never count", () => {
    const items = [item("mt", "n1"), item("m1", "n2", { anchor: "ag-1" })];
    const meetings = [...input().meetings, meeting("mt", "2026-11-20", { is_test: true })];
    expect(openTasks(ORG, input({ items, meetings }), NOW)).toEqual([]);
  });

  it("a chain whose start is not loaded counts from the oldest loaded row", () => {
    const items = [item("m2", "c1", { carried_from_meeting: "gone", carried_from_id: "n9" })];
    expect(openTasks(ORG, input({ items }), NOW)[0].tasks[0].weeks).toBe(4);
  });
});

describe("recentDecisions", () => {
  it("newest first with the agenda label; the last 12 months; Testmöte and Må-runda left out", () => {
    const meetings = [...input().meetings, meeting("old", "2025-09-01"), meeting("mt", "2026-11-21", { is_test: true })];
    const items = [
      decision("m1", "d1", "Medlemsavgiften blir 100 kr"),
      decision("m3", "d2", "Spelkvällen flyttas till torsdagar", "ag-3"),
      decision("m3", "d3", "Inget om Må-rundan", "ag-1"),
      decision("old", "d4", "Gammalt beslut"),
      decision("mt", "d5", "Testbeslut"),
      decision("m2", "d6", "Utan punkt", "ag-9"),
      item("m2", "d7", { section: "decision", kind: "decision", text: "Kopia", copy_of: "d6" }),
    ];
    expect(recentDecisions(ORG, input({ meetings, items }), NOW).map((d) => [d.text, d.item, d.date.slice(0, 10)])).toEqual([
      ["Spelkvällen flyttas till torsdagar", "Spelkväll", "2026-11-19"],
      ["Utan punkt", null, "2026-10-29"],
      ["Medlemsavgiften blir 100 kr", "Ekonomi", "2026-10-01"],
    ]);
  });

  it("legacy rows without a kind count by section; meetings before 0028 have no label", () => {
    const meetings = [meeting("v1", "2026-11-01", { agenda_labels: {}, agenda_roles: {} })];
    const items = [item("v1", "x1", { kind: null, section: "decision", text: "Gammalt format", anchor: null })];
    expect(recentDecisions(ORG, input({ meetings, items }), NOW)).toEqual([{ key: "v1:x1", text: "Gammalt format", date: "2026-11-01T17:00:00Z", item: null }]);
  });
});

describe("recurringTopics", () => {
  it("topic labels in ≥ 2 meetings, matched by normLabel, decisions per month newest first; fixed roles left out", () => {
    const meetings = [
      meeting("m1", "2026-10-01"),
      meeting("m2", "2026-10-29", { agenda_labels: { "ag-1": "Må-runda", "ag-2": "ekonomi:", "ag-3": "Styrelsefika", "ag-4": "Övrigt" } }),
      meeting("m3", "2026-11-19"),
    ];
    const items = [
      decision("m1", "d1", "Budgeten godkänns"),
      decision("m2", "d2", "Kassören byter bank"),
      decision("m3", "d3", "Nya tärningar köps in"),
      decision("m3", "d4", "Spelkvällen blir varannan vecka", "ag-3"),
    ];
    const topics = recurringTopics(ORG, input({ meetings, items }));
    expect(topics.map((t) => [t.label, t.meetings])).toEqual([
      ["Ekonomi", 3],
      ["Spelkväll", 2],
    ]);
    expect(topics[0].months).toEqual([
      { month: "2026-11", decisions: ["Nya tärningar köps in"] },
      { month: "2026-10", decisions: ["Budgeten godkänns", "Kassören byter bank"] },
    ]);
    expect(topics.some((t) => /må-runda|övrigt/i.test(t.label))).toBe(false);
  });

  it("no labels stored (before 0028): no topics", () => {
    const meetings = input().meetings.map((m) => ({ ...m, agenda_labels: {} }));
    expect(recurringTopics(ORG, input({ meetings }))).toEqual([]);
  });
});

describe("attendance", () => {
  it("named people per meeting through merges, over meetings where anyone was named; everyone listed by name", () => {
    const sp = (meeting_id: string, label: string, person_id: string | null, merged_into_label: string | null = null) => ({
      meeting_id,
      el_session_id: `${meeting_id}-s`,
      speaker_label: label,
      person_id,
      display_name: person_id ?? label,
      merged_into_label,
    });
    const speakers = [
      sp("m1", "0", "p-ada"),
      sp("m1", "1", null, "0"), // merged into Ada: still one attendance
      sp("m1", "2", "p-bo"),
      sp("m2", "0", null), // nobody named: the meeting does not count
      sp("m3", "0", "p-ada"),
      sp("m3", "1", "p-gone"), // not in the people list any more
    ];
    const a = attendance(ORG, input({ speakers }));
    expect(a.meetings).toBe(2);
    expect(a.people.map((p) => [p.name, p.attended, p.lastSeen?.slice(0, 10) ?? null])).toEqual([
      ["Ada Kask", 2, "2026-11-19"],
      ["Bo Tärn", 1, "2026-10-01"],
      ["Cid Ört", 0, null],
    ]);
  });

  it("a Testmöte's speakers never count", () => {
    const meetings = [...input().meetings, meeting("mt", "2026-11-20", { is_test: true })];
    const speakers = [{ meeting_id: "mt", el_session_id: "s", speaker_label: "0", person_id: "p-ada", display_name: "Ada" }];
    expect(attendance(ORG, input({ meetings, speakers })).meetings).toBe(0);
  });
});

describe("buildOverview", () => {
  it("empty förening", () => {
    const o = buildOverview(ORG, { meetings: [], items: [], speakers: [], people: [] }, NOW);
    expect(o).toEqual({
      meetingCount: 0,
      firstMeeting: null,
      lastMeeting: null,
      openTasks: [],
      decisions: [],
      topics: [],
      attendance: { meetings: 0, people: [] },
    });
  });
});
