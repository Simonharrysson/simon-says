import { describe, expect, it } from "vitest";
import { basisLine, formatDay, formatMonth, formatWeeks, matchesQuery } from "./format";

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
    expect([0, 1, 3].map(formatWeeks)).toEqual(["ny den här veckan", "1 vecka", "3 veckor"]);
  });
  it("matchesQuery: every word, any order, case-insensitive", () => {
    expect(matchesQuery("Hyran höjs till 2 000 kr · Ekonomi", "ekonomi hyran")).toBe(true);
    expect(matchesQuery("Hyran höjs", "HYRAN")).toBe(true);
    expect(matchesQuery("Hyran höjs", "hyra lokal")).toBe(false);
    expect(matchesQuery("vad som helst", "  ")).toBe(true);
  });

  it("basisLine: own meetings, imported protocols, both, none", () => {
    const none = { count: 0, first: null, last: null, tasks: 0 };
    const imp = { count: 48, first: "2024-10-08", last: "2026-11-03", tasks: 90 };
    expect(basisLine({ meetingCount: 0, firstMeeting: null, imported: none }, now)).toBe("Översikten fylls på när föreningen har haft sitt första möte med Simon Says.");
    expect(basisLine({ meetingCount: 1, firstMeeting: "2026-11-17T17:00:00Z", imported: none }, now)).toBe("Bygger på 1 avslutat möte sedan 17 nov. Testmöten räknas inte.");
    expect(basisLine({ meetingCount: 3, firstMeeting: "2026-11-03T17:00:00Z", imported: imp }, now)).toBe(
      "Bygger på 48 importerade protokoll och 3 möten med Simon Says sedan 8 okt 2024. Testmöten räknas inte.",
    );
    expect(basisLine({ meetingCount: 0, firstMeeting: null, imported: { ...imp, count: 1 } }, now)).toBe(
      "Bygger på 1 importerat protokoll sedan 8 okt 2024. Möten med Simon Says räknas in efter det första mötet.",
    );
  });
});
