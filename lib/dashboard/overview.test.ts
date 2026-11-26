import { describe, expect, it } from "vitest";
import { buildOverview, countedMeetings, importedSummary, recurringTopics, type DashInput, type DashItem, type DashMeeting } from "./overview";
import type { HistoryItem, HistoryMeeting } from "@/lib/history/types";

// Fictional förening: "Brädspelsföreningen Tärningen". No real people or content.

const ORG = "org-1";

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

function input(over: Partial<DashInput> = {}): DashInput {
  return {
    meetings: [meeting("m1", "2026-10-01"), meeting("m2", "2026-10-29"), meeting("m3", "2026-11-19")],
    items: [],
    people: [],
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

describe("buildOverview", () => {
  it("empty förening", () => {
    expect(buildOverview(ORG, [])).toEqual({ meetingCount: 0, firstMeeting: null, imported: { count: 0, first: null, last: null } });
  });
  it("counts own ended meetings (no Testmöte) and imported protocols with their span", () => {
    const meetings = [...input().meetings, meeting("mt", "2026-11-20", { is_test: true })];
    const o = buildOverview(ORG, meetings, history);
    expect(o).toEqual({ meetingCount: 3, firstMeeting: "2026-10-01T17:00:00Z", imported: { count: 2, first: "2024-10-08", last: "2026-10-01" } });
    expect(importedSummary([])).toEqual({ count: 0, first: null, last: null });
  });
});

// Imported old protocols (lib/history): already name-scrubbed.
const hi = (kind: HistoryItem["kind"], text: string, topic: string | null = null, over: Partial<HistoryItem> = {}): HistoryItem => ({
  kind,
  text,
  topic,
  owner: null,
  done: null,
  ...over,
});
const protocol = (date: string, items: HistoryItem[]): HistoryMeeting => ({ date, source: "import", items });
const history = [
  protocol("2024-10-08", [hi("topic", "Ekonomi"), hi("topic", "Spelkafé"), hi("decision", "Kassan flyttas till ny bank", "Ekonomi"), hi("task", "Ringa banken", "Ekonomi", { owner: "Kassör", done: false })]),
  protocol("2026-10-01", [hi("decision", "Spelkaféet blir varannan fredag", "spelkafé"), hi("decision", "Utan punkt"), hi("task", "Boka lokal", "Spelkafé", { done: true })]),
];
// Formalities sit in every protocol: never recurring topics; nothing under a Må-runda shows.
const formalities = (date: string) =>
  protocol(date, [
    hi("topic", "§1 Mötets öppnande"),
    hi("topic", "Val av justerare"),
    hi("topic", "Må-runda"),
    hi("topic", "Övriga frågor"),
    hi("decision", "Mötet förklaras öppnat", "Mötets öppnande"),
    hi("decision", "Privat sak från rundan", "Må-runda"),
  ]);

describe("imported protocols in the Översikt", () => {
  it("recurring topics count imported protocols (topic lines and the topics lines sit under) with their decisions", () => {
    const meetings = [meeting("m1", "2026-10-29")];
    const items = [decision("m1", "d1", "Budgeten godkänns")];
    const topics = recurringTopics(ORG, input({ meetings, items }), history);
    expect(topics.map((t) => [t.label, t.meetings, t.lastSeen.slice(0, 10)])).toEqual([
      ["Ekonomi", 2, "2026-10-29"],
      ["Spelkafé", 2, "2026-10-01"],
    ]);
    expect(topics[0].months).toEqual([
      { month: "2026-10", decisions: ["Budgeten godkänns"] },
      { month: "2024-10", decisions: ["Kassan flyttas till ny bank"] },
    ]);
    // Spelkväll is on one own meeting only.
    expect(topics.some((t) => t.label === "Spelkväll")).toBe(false);
  });

  it("formalities and the Må-runda in imported protocols are not topics", () => {
    const old = [formalities("2025-01-14"), formalities("2025-02-11"), formalities("2025-03-11")];
    expect(recurringTopics(ORG, input({ meetings: [] }), old)).toEqual([]);
  });
});
