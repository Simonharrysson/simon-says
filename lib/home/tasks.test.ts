import { describe, expect, it } from "vitest";
import {
  canTick,
  isMine,
  isOverdue,
  meetingCounts,
  myForeningTasks,
  myHandoffTasks,
  myPrivatTasks,
  pendingHandoffs,
  sortTasks,
  stockholmDay,
  type HandoffRow,
  type HomeMeeting,
  type HomeNoteRow,
  type HomePerson,
  type HomeSpace,
} from "./tasks";

const ME = "user-me";
const OTHER = "user-other";

const row = (meeting: string, id: string, over: Partial<HomeNoteRow> = {}): HomeNoteRow => ({
  meeting_id: meeting,
  id,
  section: "action",
  kind: "task",
  text: `Uppgift ${id}`,
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: null,
  range_name: null,
  position: 0,
  done: false,
  ...over,
});

const spaces: HomeSpace[] = [
  { id: "hook", name: "Hook & Look", kind: "forening", isAdmin: false },
  { id: "ais", name: "AI Society", kind: "forening", isAdmin: true },
];

const people: HomePerson[] = [
  { id: "p-simon", org_id: "hook", name: "Simon Harr", role: "Kassör", member_user_id: ME },
  { id: "p-anna", org_id: "hook", name: "Anna Berg", role: "Ordförande", member_user_id: OTHER },
  { id: "p-simon2", org_id: "ais", name: "Simon Harr", role: null, member_user_id: ME },
  { id: "p-sara", org_id: "ais", name: "Sara Lind", role: "Kassör", member_user_id: null },
];

const meeting = (id: string, org: string, started: string, over: Partial<HomeMeeting> = {}): HomeMeeting => ({
  id,
  org_id: org,
  started_at: started,
  status: "done",
  is_test: false,
  ...over,
});

describe("isMine: by person link or role held", () => {
  const hookPeople = people.filter((p) => p.org_id === "hook");
  const mine = new Set(["p-simon"]);
  it("matches the owner link", () => {
    expect(isMine({ owner: null, owner_person_id: "p-simon" }, hookPeople, mine)).toBe(true);
  });
  it("matches the owner text by name, first name or a role I hold (definite form too)", () => {
    expect(isMine({ owner: "Simon Harr", owner_person_id: null }, hookPeople, mine)).toBe(true);
    expect(isMine({ owner: "Simon", owner_person_id: null }, hookPeople, mine)).toBe(true);
    expect(isMine({ owner: "Kassör", owner_person_id: null }, hookPeople, mine)).toBe(true);
    expect(isMine({ owner: "kassören", owner_person_id: null }, hookPeople, mine)).toBe(true);
  });
  it("an owner link decides alone: a role that moved to me doesn't bring the old holder's linked task", () => {
    // Anna linked the task when she was Kassör; the role is mine now.
    expect(isMine({ owner: "Kassör", owner_person_id: "p-anna" }, hookPeople, mine)).toBe(false);
    expect(isMine({ owner: "Kassör", owner_person_id: null }, hookPeople, mine)).toBe(true);
  });
  it("never someone else's task, an unknown owner, or anything when I'm not in the people list", () => {
    expect(isMine({ owner: "Ordförande", owner_person_id: null }, hookPeople, mine)).toBe(false);
    expect(isMine({ owner: "Anna", owner_person_id: "p-anna" }, hookPeople, mine)).toBe(false);
    expect(isMine({ owner: "Okänd", owner_person_id: null }, hookPeople, mine)).toBe(false);
    expect(isMine({ owner: null, owner_person_id: null }, hookPeople, mine)).toBe(false);
    expect(isMine({ owner: "Simon", owner_person_id: null }, hookPeople, new Set())).toBe(false);
  });
});

describe("myForeningTasks", () => {
  const meetings = [
    meeting("m1", "hook", "2026-11-19T17:00:00Z"),
    meeting("m2", "hook", "2026-11-26T17:00:00Z"),
    meeting("a1", "ais", "2026-11-25T17:00:00Z"),
    meeting("live", "hook", "2026-11-27T17:00:00Z", { status: "live" }),
    meeting("test", "hook", "2026-11-20T17:00:00Z", { is_test: true }),
    meeting("x1", "other-org", "2026-11-20T17:00:00Z"),
  ];
  const rows = [
    // Carried 1 → 2: listed once, as the latest copy.
    row("m1", "n1", { owner: "Kassör", text: "Boka lokal" }),
    row("m2", "c1", { owner: "Kassör", owner_person_id: "p-simon", text: "Boka lokal", carried_from_meeting: "m1", carried_from_id: "n1" }),
    // Someone else's.
    row("m2", "n2", { owner: "Anna", text: "Skicka inbjudan" }),
    // Done through its tasks copy.
    row("m2", "n3", { owner: "Simon", text: "Köpa bollar" }),
    row("m2", "n3-t", { owner: "Simon", text: "Köpa bollar", copy_of: "n3", anchor: "tasks", done: true }),
    // Deleted by a human; Må-runda.
    row("m2", "n4", { owner: "Simon", deleted_by_human: true }),
    row("m2", "n5", { owner: "Simon", anchor: "maruna" }),
    // A decision is not a task.
    row("m2", "d1", { section: "decision", kind: "decision", owner: "Simon" }),
    // My role in the other förening is not Kassör: Sara holds it there.
    row("a1", "n1", { owner: "Kassör", text: "Skicka budget" }),
    row("a1", "n2", { owner_person_id: "p-simon2", text: "Boka talare", due: "4 dec", due_date: "2026-12-04", done_when: "bekräftad" }),
    // Live meeting, Testmöte and a förening I'm not in: never.
    row("live", "n1", { owner: "Simon" }),
    row("test", "n1", { owner: "Simon" }),
    row("x1", "n1", { owner_person_id: "p-simon" }),
  ];
  const withRoles = meetings.map((m) => (m.id === "m2" ? { ...m, agenda_roles: { maruna: "checkin" as const } } : m));
  const tasks = myForeningTasks({ userId: ME, spaces, meetings: withRoles, rows, people });

  it("lists only my tasks, each once, open and done", () => {
    expect(tasks.map((t) => `${t.key} ${t.done ? "done" : "open"}`).sort()).toEqual(["n:a1:n2 open", "n:m2:c1 open", "n:m2:n3 done"]);
  });
  it("carries the fields and the space", () => {
    const t = tasks.find((x) => x.key === "n:a1:n2")!;
    expect(t).toMatchObject({ spaceName: "AI Society", text: "Boka talare", due: "4 dec", dueDate: "2026-12-04", doneWhen: "bekräftad", meetingId: "a1", itemId: "n2" });
  });
  it("a locked row shows the human's text only", () => {
    const [t] = myForeningTasks({
      userId: ME,
      spaces,
      meetings,
      rows: [row("m2", "n9", { owner_person_id: "p-simon", text: "Mänsklig text", due: "fredag", locked: true })],
      people,
    });
    expect(t).toMatchObject({ text: "Mänsklig text", due: null });
  });
  it("nothing for a user with no person link", () => {
    expect(myForeningTasks({ userId: "nobody", spaces, meetings, rows, people })).toEqual([]);
  });
});

describe("myPrivatTasks", () => {
  it("every task without another owner, with its context", () => {
    const tasks = myPrivatTasks({
      space: { id: "priv", name: "Privat", kind: "privat", isAdmin: true },
      contexts: [{ id: "c1", name: "TDDE15" }],
      meetings: [{ id: "pm1", started_at: "2026-11-25T10:00:00Z" }],
      tasks: [
        { id: "t1", context_id: "c1", meeting_id: "pm1", text: "Läsa kap 4", owner: null, done: false, created_at: "2026-11-25T11:00:00Z" },
        { id: "t2", context_id: "c1", meeting_id: "pm1", text: "Fixa figurerna", owner: "Anna", done: false, created_at: "2026-11-25T11:00:00Z" },
      ],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ key: "p:t1", kind: "privat", contextName: "TDDE15", meetingAt: "2026-11-25T10:00:00Z" });
  });
  it("none without a Privat space", () => {
    expect(myPrivatTasks({ space: null, tasks: [], contexts: [], meetings: [] })).toEqual([]);
  });
});

describe("canTick: owner or admin only", () => {
  it.each([
    [true, false, true],
    [false, true, true],
    [true, true, true],
    [false, false, false],
  ])("mine=%s admin=%s → %s", (mine, isAdmin, ok) => {
    expect(canTick({ mine, isAdmin })).toBe(ok);
  });
});

describe("sortTasks and overdue", () => {
  const t = (key: string, dueDate: string | null, meetingAt: string, position = 0) => ({ key, dueDate, meetingAt, position, done: false });
  it("deadline first, none last; then newest meeting, then position", () => {
    const sorted = sortTasks([
      t("none-old", null, "2026-11-01T00:00:00Z"),
      t("dec8", "2026-12-08", "2026-11-01T00:00:00Z"),
      t("none-new", null, "2026-11-20T00:00:00Z", 1),
      t("none-new-first", null, "2026-11-20T00:00:00Z", 0),
      t("dec4", "2026-12-04", "2026-11-01T00:00:00Z"),
    ]);
    expect(sorted.map((x) => x.key)).toEqual(["dec4", "dec8", "none-new-first", "none-new", "none-old"]);
  });
  it("overdue: an open task whose day is before today in Stockholm", () => {
    const today = stockholmDay(new Date("2026-12-04T23:30:00Z")); // already 5 Dec in Stockholm
    expect(today).toBe("2026-12-05");
    expect(isOverdue({ dueDate: "2026-12-04", done: false }, today)).toBe(true);
    expect(isOverdue({ dueDate: "2026-12-05", done: false }, today)).toBe(false);
    expect(isOverdue({ dueDate: "2026-12-04", done: true }, today)).toBe(false);
    expect(isOverdue({ dueDate: null, done: false }, today)).toBe(false);
  });
});

describe("meetingCounts", () => {
  it("decisions and tasks, without copies, deleted rows or Må-runda", () => {
    const rows = [
      row("m", "d1", { section: "decision", kind: "decision" }),
      row("m", "d2", { section: "decision", kind: "decision", deleted_by_human: true }),
      row("m", "n1"),
      row("m", "n1-t", { copy_of: "n1" }),
      row("m", "n2", { anchor: "maruna" }),
      row("m", "note", { section: "note", kind: "note" }),
    ];
    expect(meetingCounts(rows, { maruna: "checkin" })).toEqual({ decisions: 1, tasks: 1 });
  });
});

describe("Företag handoffs (0050)", () => {
  const spaces = [{ id: "ftg", name: "Testbolag", kind: "foretag" as const, isAdmin: false }];
  const people = [
    { id: "p-kim", org_id: "ftg", name: "Kim", role: null, member_user_id: "kim" },
    { id: "p-anna", org_id: "ftg", name: "Anna", role: null, member_user_id: "anna" },
  ];
  const row = (over: Partial<HandoffRow>): HandoffRow => ({
    id: "h1",
    org_id: "ftg",
    meeting_id: "m-ceo",
    owner_person_id: "p-kim",
    text: "Ta fram siffror",
    due: "fredag",
    due_date: "2026-12-04",
    from_name: "Anna",
    status: "approved",
    done: false,
    created_at: "2026-11-27T10:00:00Z",
    ...over,
  });

  it("an approved task: the reviewed text, the giver and the deadline, never its meeting", () => {
    const [task, ...rest] = myHandoffTasks({ userId: "kim", spaces, handoffs: [row({})], people });
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ key: "h:h1", kind: "handoff", text: "Ta fram siffror", fromName: "Anna", due: "fredag", dueDate: "2026-12-04", meetingId: "" });
    expect(JSON.stringify(task)).not.toContain("m-ceo");
  });

  it("pending or someone else's: not in my tasks", () => {
    expect(myHandoffTasks({ userId: "kim", spaces, handoffs: [row({ status: "pending" })], people })).toEqual([]);
    expect(myHandoffTasks({ userId: "anna", spaces, handoffs: [row({})], people })).toEqual([]);
  });

  it("pending ones become approvals, with the owner's name", () => {
    expect(pendingHandoffs({ spaces, handoffs: [row({ status: "pending" }), row({ id: "h2" })], people })).toEqual([
      { id: "h1", spaceId: "ftg", spaceName: "Testbolag", meetingId: "m-ceo", text: "Ta fram siffror", due: "fredag", ownerName: "Kim", createdAt: "2026-11-27T10:00:00Z" },
    ]);
  });
});
