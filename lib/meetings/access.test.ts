import { describe, expect, it } from "vitest";
import { canEndFromOrgPage, canEndMeeting, canRunMeeting } from "./access";

describe("meeting access", () => {
  it("any member of the förening may run (continue) a meeting; outsiders may not", () => {
    expect(canRunMeeting("admin")).toBe(true);
    expect(canRunMeeting("member")).toBe(true);
    expect(canRunMeeting(null)).toBe(false);
  });

  it("whoever runs it may end it from the live page", () => {
    expect(canEndMeeting("member")).toBe(true);
    expect(canEndMeeting("admin")).toBe(true);
    expect(canEndMeeting(null)).toBe(false);
  });

  it("the org page's Avsluta: admins and the starter, not other members or a removed starter", () => {
    expect(canEndFromOrgPage("admin", false)).toBe(true);
    expect(canEndFromOrgPage("member", true)).toBe(true);
    expect(canEndFromOrgPage("member", false)).toBe(false);
    expect(canEndFromOrgPage(null, true)).toBe(false);
  });
});
