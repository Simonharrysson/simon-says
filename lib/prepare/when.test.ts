import { describe, expect, it } from "vitest";
import { proposedWhen } from "./when";

describe("proposedWhen", () => {
  const now = new Date("2026-11-26T10:00:00Z"); // Thursday 11:00 in Stockholm

  it("the last meeting's weekday on or after today, its time rounded to the quarter hour", () => {
    // Last meeting: Tuesday 2026-11-24 18:07 Stockholm → next Tuesday, 18:00.
    expect(proposedWhen(now, "2026-11-24T17:07:00Z")).toEqual({ today: "2026-11-26", date: "2026-12-01", time: "18:00" });
    // Last meeting on a Thursday: today.
    expect(proposedWhen(now, "2026-11-19T18:35:00Z")).toEqual({ today: "2026-11-26", date: "2026-11-26", time: "19:30" });
  });

  it("no meeting yet: today, no time", () => {
    expect(proposedWhen(now, null)).toEqual({ today: "2026-11-26", date: "2026-11-26", time: "" });
  });
});
