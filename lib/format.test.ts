import { describe, expect, it } from "vitest";
import { formatAgo, formatClock, formatCount, formatDateTime, formatDuration, formatElapsed, formatMeetingDate, minutesBetween, plural, tailText } from "./format";

describe("formatElapsed", () => {
  it("shows mm:ss under an hour", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(249_000)).toBe("04:09");
  });
  it("shows h:mm:ss from an hour", () => {
    expect(formatElapsed(3_729_000)).toBe("1:02:09");
    expect(formatElapsed(4 * 3600_000)).toBe("4:00:00");
  });
  it("never goes negative", () => {
    expect(formatElapsed(-5000)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it.each([
    [30, "under 1 min"],
    [45 * 60, "45 min"],
    [72 * 60, "1 h 12 min"],
    [7200, "2 h"],
  ])("%i s → %s", (s, out) => expect(formatDuration(s)).toBe(out));
});

describe("dates in Stockholm time", () => {
  it("formats winter time (UTC+1)", () => {
    expect(formatClock("2026-11-24T17:05:00Z")).toBe("18:05");
    expect(formatDateTime("2026-11-24T17:05:00Z")).toBe("24 nov 2026 kl. 18:05");
  });
  it("formats summer time (UTC+2)", () => {
    expect(formatClock("2026-06-10T08:30:00Z")).toBe("10:30");
  });
});

describe("minutesBetween / plural", () => {
  it("floors and clamps", () => {
    const now = new Date("2026-11-24T18:00:00Z");
    expect(minutesBetween("2026-11-24T17:56:30Z", now)).toBe(3);
    expect(minutesBetween("2026-11-24T18:05:00Z", now)).toBe(0);
  });
  it("picks the form", () => {
    expect(plural(1, "person", "personer")).toBe("1 person");
    expect(plural(3, "person", "personer")).toBe("3 personer");
  });
});

describe("tailText", () => {
  it("keeps short text as is", () => {
    expect(tailText("  hej på er  ", 50)).toBe("hej på er");
  });
  it("keeps the newest words and cuts at a word boundary", () => {
    const out = tailText("ett två tre fyra fem sex sju åtta", 16);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("sju åtta")).toBe(true);
    expect(out).toBe("…sex sju åtta");
    expect(out.length).toBeLessThanOrEqual(17);
  });
});

describe("live and list helpers", () => {
  it("formatAgo", () => {
    expect(formatAgo(0)).toBe("nyss");
    expect(formatAgo(1.7)).toBe("för 1 min sedan");
    expect(formatAgo(12)).toBe("för 12 min sedan");
  });
  it("formatMeetingDate drops the current year", () => {
    const now = new Date("2026-11-30T12:00:00Z");
    expect(formatMeetingDate("2026-11-24T18:00:00Z", now)).toBe("tis 24 nov · 19:00");
    expect(formatMeetingDate("2025-11-24T18:00:00Z", now)).toBe("mån 24 nov 2025 · 19:00");
  });
  it("formatCount uses a narrow no-break space", () => {
    expect(formatCount(1284)).toBe("1 284");
    expect(formatCount(7)).toBe("7");
  });
});
