import { describe, expect, it } from "vitest";
import { splitMeetings, MEETINGS_SHOWN } from "@/components/views/OrgDetailView";
import { countItems } from "./list";
import type { ChainItem } from "./summary";

const item = (over: Partial<ChainItem>): ChainItem => ({
  meeting_id: "m1",
  id: "n1",
  section: "decision",
  kind: null,
  done: false,
  deleted_by_human: false,
  copy_of: null,
  carried_from_meeting: null,
  carried_from_id: null,
  ...over,
});

describe("countItems", () => {
  it("counts primary decisions and the tasks written in the meeting", () => {
    const counts = countItems([
      item({ id: "n1", kind: "decision" }),
      item({ id: "n2", section: "action" }), // legacy task row
      item({ id: "n3", kind: "task" }),
      item({ id: "n3-t", kind: "task", copy_of: "n3" }), // tasks-section copy
      item({ id: "n4", kind: "task", deleted_by_human: true }),
      item({ id: "c1", kind: "task", carried_from_meeting: "m0", carried_from_id: "n9" }), // Från förra veckan
      item({ meeting_id: "m2", id: "n1", kind: "decision" }),
    ]);
    expect(counts.get("m1")).toEqual({ decisions: 1, tasks: 2 });
    expect(counts.get("m2")).toEqual({ decisions: 1, tasks: 0 });
  });
});

describe("splitMeetings", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, n)).toISOString();
  const m = (id: string, n: number, status: "live" | "ending" | "done" | "abandoned" = "done") => ({
    id,
    status,
    started_at: day(n),
    ended_at: status === "done" ? day(n) : null,
    doc_id: "d",
    started_by: null,
  });

  it("newest first, five shown, the rest under Visa fler; finished Testmöten apart", () => {
    const meetings = [m("a", 1), m("b", 2), m("c", 3), m("d", 4), m("e", 5), m("f", 6), m("g", 7), m("t1", 8), m("t2", 9, "live")];
    const info = Object.fromEntries(meetings.map((x) => [x.id, { title: null, isTest: x.id.startsWith("t"), decisions: 0, tasks: 0 }]));
    const { shown, more, tests } = splitMeetings(meetings, info);
    expect(MEETINGS_SHOWN).toBe(5);
    // A running Testmöte stays in the list (it has controls).
    expect(shown.map((x) => x.id)).toEqual(["t2", "g", "f", "e", "d"]);
    expect(more.map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(tests.map((x) => x.id)).toEqual(["t1"]);
  });

  it("without the info everything is a real meeting", () => {
    expect(splitMeetings([m("a", 1)], undefined)).toEqual({ shown: [m("a", 1)], more: [], tests: [] });
  });
});
