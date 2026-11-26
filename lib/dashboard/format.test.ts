import { describe, expect, it } from "vitest";
import { formatDay, formatMonth, formatWeeks, matchesQuery } from "./format";

describe("dashboard format", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  it("formatDay: year only when not this year", () => {
    expect(formatDay("2026-11-24T17:00:00Z", now)).toBe("24 nov");
    expect(formatDay("2025-09-02T17:00:00Z", now)).toBe("2 sep 2025");
  });
  it("formatMonth", () => {
    expect(formatMonth("2026-11")).toBe("november 2026");
    expect(formatMonth("2027-01")).toBe("januari 2027");
  });
  it("formatWeeks", () => {
    expect([0, 1, 3].map(formatWeeks)).toEqual(["ny i veckan", "1 vecka", "3 veckor"]);
  });
  it("matchesQuery: every word, any order, case-insensitive", () => {
    expect(matchesQuery("Hyran höjs till 2 000 kr · Ekonomi", "ekonomi hyran")).toBe(true);
    expect(matchesQuery("Hyran höjs", "HYRAN")).toBe(true);
    expect(matchesQuery("Hyran höjs", "hyra lokal")).toBe(false);
    expect(matchesQuery("vad som helst", "  ")).toBe(true);
  });
});
