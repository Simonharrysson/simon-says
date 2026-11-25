import { describe, expect, it } from "vitest";
import { meetingChainSummary, type ChainItem, type ChainMeeting } from "./summary";

const meeting = (id: string, day: number, over: Partial<ChainMeeting> = {}): ChainMeeting => ({
  id,
  org_id: "o",
  started_at: `2026-11-${String(day).padStart(2, "0")}T17:00:00Z`,
  status: "done",
  is_test: false,
  ...over,
});
const item = (meeting_id: string, id: string, over: Partial<ChainItem> = {}): ChainItem => ({
  meeting_id,
  id,
  section: "action",
  kind: "task",
  done: false,
  deleted_by_human: false,
  copy_of: null,
  carried_from_meeting: null,
  carried_from_id: null,
  ...over,
});

describe("meetingChainSummary", () => {
  it("counts decisions and tasks per meeting, oldest first; copies, deleted rows, notes and info rows do not count", () => {
    const meetings = [meeting("m2", 9), meeting("m1", 2)];
    const items = [
      item("m1", "n1"),
      item("m1", "n1-t", { copy_of: "n1" }),
      item("m1", "n2", { section: "decision", kind: "decision" }),
      item("m1", "n3", { section: "decision", kind: null }), // legacy v1 row
      item("m1", "n4", { deleted_by_human: true }),
      item("m1", "n5", { section: "note", kind: "note" }),
      item("m1", "info-tid", { section: "note", kind: "note" }),
      item("m1", "n6", { section: "action", kind: null }), // legacy v1 task
    ];
    expect(meetingChainSummary("o", { meetings, items })).toEqual([
      { meetingId: "m1", startedAt: "2026-11-02T17:00:00Z", decisions: 2, tasksOpened: 2, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: "m2", startedAt: "2026-11-09T17:00:00Z", decisions: 0, tasksOpened: 0, tasksClosed: 0, tasksOpen: 0 },
    ]);
  });

  it("a carried task closed the next week counts as closed there, not where it was opened (the source row's done came from propagateDone)", () => {
    const meetings = [meeting("m1", 2), meeting("m2", 9)];
    const items = [
      item("m1", "n1", { done: true }), // flipped by propagateDone
      item("m1", "n2"),
      item("m2", "c1", { done: true, carried_from_meeting: "m1", carried_from_id: "n1" }),
      item("m2", "c2", { carried_from_meeting: "m1", carried_from_id: "n2" }),
      item("m2", "n1", { done: true }), // opened and closed in the same meeting
    ];
    expect(meetingChainSummary("o", { meetings, items }).map(({ startedAt: _s, ...r }) => r)).toEqual([
      { meetingId: "m1", decisions: 0, tasksOpened: 2, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: "m2", decisions: 0, tasksOpened: 1, tasksClosed: 2, tasksOpen: 1 },
    ]);
  });

  it("done through the tasks copy (R-A6: a human edited the primary) counts as closed", () => {
    const items = [item("m1", "n1"), item("m1", "n1-t", { copy_of: "n1", done: true })];
    expect(meetingChainSummary("o", { meetings: [meeting("m1", 2)], items })[0]).toMatchObject({ tasksClosed: 1, tasksOpen: 0 });
  });

  it("only the org's meetings of the same kind: Testmöten and real meetings never mix", () => {
    const meetings = [meeting("real", 2), meeting("test", 3, { is_test: true }), meeting("other", 4, { org_id: "o2" })];
    const items = [item("real", "n1"), item("test", "n1"), item("test", "n2"), item("other", "n1")];
    expect(meetingChainSummary("o", { meetings, items }).map((r) => r.meetingId)).toEqual(["real"]);
    expect(meetingChainSummary("o", { meetings, items }, { isTest: true })).toEqual([
      { meetingId: "test", startedAt: "2026-11-03T17:00:00Z", decisions: 0, tasksOpened: 2, tasksClosed: 0, tasksOpen: 2 },
    ]);
  });

  it("a false start is a row of its own; the meeting that took its carried lines over counts them once more as its own open tasks", () => {
    const meetings = [meeting("m1", 2), meeting("false", 9, { status: "done" }), meeting("m2", 9, { started_at: "2026-11-09T17:10:00Z" })];
    const items = [
      item("m1", "n1"),
      item("false", "c1", { carried_from_meeting: "m1", carried_from_id: "n1" }),
      item("m2", "c1", { carried_from_meeting: "m1", carried_from_id: "n1", done: true }),
    ];
    expect(meetingChainSummary("o", { meetings, items }).map((r) => [r.meetingId, r.tasksOpened, r.tasksClosed, r.tasksOpen])).toEqual([
      ["m1", 1, 0, 1],
      ["false", 0, 0, 1],
      ["m2", 0, 1, 0],
    ]);
  });
});
