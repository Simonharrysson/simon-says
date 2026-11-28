import { describe, expect, it } from "vitest";
import { filterSortOrgs, isoWeek, niceMax, parseOrgRows, parseOverview, type AdminOrgRow } from "./stats";

describe("parseOverview", () => {
  it("reads bigints sent as strings and fills what is missing with 0", () => {
    const o = parseOverview({ users: "12", active7: 3, orgs: { forening: "2", privat: 5 }, weeks: [{ week: "2026-11-23", meetings: "4", users: 1 }], health: { briefs: "1" } });
    expect(o.users).toBe(12);
    expect(o.active30).toBe(0);
    expect(o.orgs).toEqual({ forening: 2, foretag: 0, privat: 5 });
    expect(o.weeks).toEqual([{ week: "2026-11-23", meetings: 4, users: 1 }]);
    expect(o.health).toEqual({ summaries: 0, summaryMails: 0, briefs: 1, invites: 0 });
    expect(parseOverview(null).weeks).toEqual([]);
  });
});

describe("parseOrgRows", () => {
  it("keeps only the shown columns", () => {
    const rows = parseOrgRows([{ id: "a", name: "Roddklubben", kind: "forening", members: "3", meetings: 2, last_meeting_at: null, created_at: "2026-01-01T00:00:00Z", created_by: "x" }]);
    expect(rows).toEqual([{ id: "a", name: "Roddklubben", kind: "forening", members: 3, meetings: 2, lastMeetingAt: null, createdAt: "2026-01-01T00:00:00Z" }]);
  });
});

describe("filterSortOrgs", () => {
  const row = (name: string, kind: AdminOrgRow["kind"], meetings: number, lastMeetingAt: string | null): AdminOrgRow => ({ id: name, name, kind, members: 1, meetings, lastMeetingAt, createdAt: "2026-01-01" });
  const rows = [row("Bokcirkeln", "forening", 5, "2026-11-01"), row("Acme AB", "foretag", 9, null), row("Privat", "privat", 1, "2026-11-20")];

  it("searches names case-insensitively", () => {
    expect(filterSortOrgs(rows, { query: "BOK", kind: "all", key: "name", dir: "asc" }).map((r) => r.name)).toEqual(["Bokcirkeln"]);
  });
  it("filters by kind", () => {
    expect(filterSortOrgs(rows, { query: "", kind: "foretag", key: "name", dir: "asc" }).map((r) => r.name)).toEqual(["Acme AB"]);
  });
  it("sorts numbers and dates both ways, empty dates last", () => {
    expect(filterSortOrgs(rows, { query: "", kind: "all", key: "meetings", dir: "desc" }).map((r) => r.meetings)).toEqual([9, 5, 1]);
    expect(filterSortOrgs(rows, { query: "", kind: "all", key: "lastMeetingAt", dir: "desc" }).map((r) => r.name)).toEqual(["Privat", "Bokcirkeln", "Acme AB"]);
    expect(filterSortOrgs(rows, { query: "", kind: "all", key: "lastMeetingAt", dir: "asc" }).map((r) => r.name)).toEqual(["Bokcirkeln", "Privat", "Acme AB"]);
  });
});

describe("isoWeek and niceMax", () => {
  it("numbers weeks the ISO way", () => {
    expect(isoWeek("2026-11-23")).toBe(48);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(isoWeek("2024-12-30")).toBe(1);
  });
  it("rounds an axis up to 1/2/5 steps", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(41)).toBe(50);
    expect(niceMax(100)).toBe(100);
  });
});
