import { describe, expect, it } from "vitest";
import { autoPickPrepared } from "./auto-pick";
import type { PreparedSuggestion } from "./types";

const prep = (over: Partial<PreparedSuggestion> = {}): PreparedSuggestion => ({
  docId: "d1",
  name: "Dagordning",
  date: "2026-11-26",
  time: "18:00",
  kind: "veckomote",
  accessible: true,
  ...over,
});

describe("autoPickPrepared", () => {
  const evening = new Date("2026-11-26T17:00:00Z");

  it("picks today's agenda the starter can edit", () => {
    expect(autoPickPrepared(prep(), evening)).toBe(true);
  });

  it("leaves an upcoming agenda as an offer", () => {
    expect(autoPickPrepared(prep({ date: "2026-12-01" }), evening)).toBe(false);
  });

  it("leaves one prepared with another account as an offer", () => {
    expect(autoPickPrepared(prep({ accessible: false }), evening)).toBe(false);
  });

  it("counts the day in Swedish time, not UTC", () => {
    // 23:30 UTC on the 25th is 00:30 on the 26th in Stockholm.
    expect(autoPickPrepared(prep(), new Date("2026-11-25T23:30:00Z"))).toBe(true);
  });

  it("is false without a prepared agenda", () => {
    expect(autoPickPrepared(null, evening)).toBe(false);
  });
});
