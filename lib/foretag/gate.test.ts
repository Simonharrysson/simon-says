import { describe, expect, it } from "vitest";
import { mayCreateForetag } from "./gate";

describe("mayCreateForetag", () => {
  const ALARM_EMAIL = "alarm@harrysson.co";
  it("FORETAG_CREATOR_EMAILS first", () => {
    const env = { FORETAG_CREATOR_EMAILS: "simon@harrysson.co", ADMIN_EMAILS: "other@x.se", ALARM_EMAIL };
    expect(mayCreateForetag("Simon@Harrysson.co", env)).toBe(true);
    expect(mayCreateForetag("other@x.se", env)).toBe(false);
  });
  it("then ADMIN_EMAILS, then ALARM_EMAIL", () => {
    expect(mayCreateForetag("other@x.se", { ADMIN_EMAILS: "other@x.se", ALARM_EMAIL })).toBe(true);
    expect(mayCreateForetag(ALARM_EMAIL, { ALARM_EMAIL })).toBe(true);
    expect(mayCreateForetag("anyone@x.se", { ALARM_EMAIL })).toBe(false);
  });
  it("no e-mail, no company", () => {
    expect(mayCreateForetag(null, { ALARM_EMAIL })).toBe(false);
  });
});
