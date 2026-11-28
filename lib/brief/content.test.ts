import { describe, expect, it } from "vitest";
import type { HomeMeeting, HomeNoteRow, HomePerson } from "@/lib/home/tasks";
import { agendaLabels, briefContent, chooseDecisions, OPEN_MAX, pickAgenda, type BriefInput } from "./content";

const ORG = "org1";
const meeting = (id: string, at: string, extra: Partial<HomeMeeting> = {}): HomeMeeting => ({ id, org_id: ORG, started_at: at, status: "done", is_test: false, title: null, ...extra });
const row = (meeting_id: string, id: string, section: "decision" | "action", text: string, extra: Partial<HomeNoteRow> = {}): HomeNoteRow => ({
  meeting_id,
  id,
  section,
  text,
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: null,
  range_name: null,
  position: 0,
  ...extra,
});
const people: HomePerson[] = [
  { id: "p-me", org_id: ORG, name: "Anna Berg", member_user_id: "me" },
  { id: "p-erik", org_id: ORG, name: "Erik Lund", member_user_id: null },
];

const base = (over: Partial<BriefInput> = {}): BriefInput => ({
  userId: "me",
  orgId: ORG,
  meetings: [meeting("m1", "2026-11-20T17:00:00Z", { title: "Budget" }), meeting("m0", "2026-11-13T17:00:00Z")],
  rows: [
    row("m1", "d1", "decision", "Hackathonet blir 14 feb"),
    row("m0", "d0", "decision", "Vi byter bank"),
    row("m1", "t1", "action", "Boka Kårallen", { owner: "Anna", due: "fredag", due_date: "2026-11-28" }),
    row("m1", "t2", "action", "Mejla sponsorer", { owner: "Erik Lund", due_date: "2026-11-20" }),
    row("m0", "t3", "action", "Skriv budget", { owner_person_id: "p-erik" }),
  ],
  people,
  agenda: null,
  today: "2026-11-27",
  meetingHref: (id) => `https://app.test/orgs/${ORG}/mote/${id}`,
  ...over,
});

describe("briefContent", () => {
  it("0068: a decision's moment only for meetings whose transcript the recipient may read", () => {
    const rows = [
      row("m1", "d1", "decision", "Hackathonet blir 14 feb", { source_segment_ids: ["el:1:0"], said_at_ms: 2_512_000 }),
      row("m0", "d0", "decision", "Vi byter bank", { source_segment_ids: ["el:2:0"], said_at_ms: 60_000 }),
    ];
    const hidden = briefContent(base({ rows }))!;
    expect(hidden.decisions.map((d) => d.saidAt)).toEqual([undefined, undefined]);
    const shown = briefContent(base({ rows, transcriptMeetings: ["m1"] }))!;
    expect(shown.decisions.map((d) => d.saidAt)).toEqual(["41:52", undefined]);
    // An old row without sources: no time, no error.
    expect(briefContent(base({ transcriptMeetings: ["m1", "m0"] }))!.decisions.every((d) => d.saidAt === undefined)).toBe(true);
  });

  it("last meeting, decisions newest first, promised vs open, mine marked", () => {
    const c = briefContent(base())!;
    expect(c.last).toEqual({ id: "m1", at: "2026-11-20T17:00:00Z", title: "Budget", href: "https://app.test/orgs/org1/mote/m1" });
    expect(c.decisions.map((d) => [d.key, d.text, d.meeting.id])).toEqual([
      ["d1", "Hackathonet blir 14 feb", "m1"],
      ["d2", "Vi byter bank", "m0"],
    ]);
    // Past due (overdue) first, then due within 3 days.
    expect(c.promised.map((t) => [t.text, t.overdue, t.mine])).toEqual([
      ["Mejla sponsorer", true, false],
      ["Boka Kårallen", false, true],
    ]);
    // No deadline: open, owner from the linked person.
    expect(c.open.map((t) => [t.text, t.owner])).toEqual([["Skriv budget", "Erik Lund"]]);
  });

  it("no history and no agenda: nothing (no mail)", () => {
    expect(briefContent(base({ meetings: [], rows: [] }))).toBeNull();
    const agenda = { labels: ["Budget"], href: "https://docs.test/a" };
    expect(briefContent(base({ meetings: [], rows: [], agenda }))).toEqual({ last: null, decisions: [], promised: [], open: [], moreOpen: 0, agenda });
  });

  it("only what the recipient can see: rows of meetings not given are ignored, as are tests, live meetings and other orgs", () => {
    const c = briefContent(
      base({
        meetings: [
          meeting("m1", "2026-11-20T17:00:00Z"),
          meeting("live", "2026-11-26T17:00:00Z", { status: "live" }),
          meeting("test", "2026-11-25T17:00:00Z", { is_test: true }),
          { ...meeting("other", "2026-11-24T17:00:00Z"), org_id: "org2" },
        ],
        rows: [
          row("m1", "d1", "decision", "Synligt beslut"),
          row("hidden", "d9", "decision", "Från ett möte mottagaren inte ser"),
          row("live", "d8", "decision", "Pågår"),
          row("test", "d7", "decision", "Testmöte"),
          row("other", "d6", "decision", "Annan organisation"),
        ],
      }),
    )!;
    expect(c.last?.id).toBe("m1");
    expect(c.decisions.map((d) => d.text)).toEqual(["Synligt beslut"]);
  });

  it("the app's task rules: done (on the row or its copy), deleted, Må-runda and carried-on rows are left out; a locked row shows text only", () => {
    const c = briefContent(
      base({
        meetings: [meeting("m2", "2026-11-26T17:00:00Z", { agenda_roles: { "ag-1": "checkin" } }), meeting("m1", "2026-11-20T17:00:00Z")],
        rows: [
          row("m1", "a", "action", "Klar på raden", { done: true }),
          row("m1", "b", "action", "Klar på kopian"),
          row("m1", "b-t", "action", "Klar på kopian", { copy_of: "b", done: true }),
          row("m1", "c", "action", "Raderad", { deleted_by_human: true }),
          row("m2", "d", "action", "Må-runda", { anchor: "ag-1" }),
          row("m1", "e", "action", "Bärs vidare", { owner: "Erik" }),
          row("m2", "e2", "action", "Bärs vidare", { owner: "Erik", carried_from_meeting: "m1", carried_from_id: "e" }),
          row("m1", "f", "action", "Ändrad i dokumentet", { owner: "Erik", due: "fredag", locked: true }),
        ],
      }),
    )!;
    expect([...c.promised, ...c.open].map((t) => [t.text, t.owner, t.due, t.meeting.id])).toEqual([
      ["Bärs vidare", "Erik", null, "m2"],
      ["Ändrad i dokumentet", null, null, "m1"],
    ]);
  });

  it("caps the open list and counts the rest", () => {
    const rows = Array.from({ length: OPEN_MAX + 2 }, (_, i) => row("m1", `t${i}`, "action", `Uppgift ${i}`));
    const c = briefContent(base({ rows }))!;
    expect(c.open).toHaveLength(OPEN_MAX);
    expect(c.moreOpen).toBe(2);
  });
});

describe("chooseDecisions", () => {
  const all = ["d1", "d2", "d3", "d4", "d5"].map((key) => ({ key, text: key, meeting: { id: "m", at: "", title: null, href: "" } }));
  it("keeps valid picks in order, drops unknown and repeated ids, fills up with the newest", () => {
    expect(chooseDecisions(all, ["d5", "x9", "d5", "d2"]).map((d) => d.key)).toEqual(["d5", "d2", "d1"]);
    expect(chooseDecisions(all, null).map((d) => d.key)).toEqual(["d1", "d2", "d3"]);
    expect(chooseDecisions(all.slice(0, 2), ["d2"]).map((d) => d.key)).toEqual(["d2", "d1"]);
  });
});

describe("agendaLabels", () => {
  it("the ticked items' labels, in order", () => {
    expect(agendaLabels([{ label: "Mötets öppnande", on: true }, { label: "Förslag", on: false }, { label: " Budget  2027 " }, { nope: 1 }])).toEqual([
      "Mötets öppnande",
      "Budget 2027",
    ]);
    expect(agendaLabels(null)).toEqual([]);
  });
});

describe("pickAgenda", () => {
  const a = (meeting_time: string | null) => ({ meeting_time });
  it("same day: the closest time within two hours; untimed only when no timed one fits", () => {
    expect(pickAgenda([a("09:00"), a("18:00"), a("17:30")], "18:15")).toEqual(a("18:00"));
    expect(pickAgenda([a("09:00")], "18:15")).toBeNull();
    expect(pickAgenda([a("09:00"), a(null)], "18:15")).toEqual(a(null));
    expect(pickAgenda([a(null)], "18:15")).toEqual(a(null));
    expect(pickAgenda([], "18:15")).toBeNull();
  });
});
