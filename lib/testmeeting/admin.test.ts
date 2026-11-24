import { describe, expect, it } from "vitest";
import { isAdminEmail } from "./admin";

describe("isAdminEmail", () => {
  it("matches the ADMIN_EMAILS list case-insensitively, ignoring spaces", () => {
    expect(isAdminEmail("Simon@X.se", " a@x.se, simon@x.se ", "alarm@x.se")).toBe(true);
    expect(isAdminEmail("b@x.se", "a@x.se,simon@x.se", "alarm@x.se")).toBe(false);
  });
  it("falls back to ALARM_EMAIL when ADMIN_EMAILS is unset or empty", () => {
    expect(isAdminEmail("ALARM@x.se", undefined, "alarm@x.se")).toBe(true);
    expect(isAdminEmail("alarm@x.se", " , ", "alarm@x.se")).toBe(true);
    expect(isAdminEmail("a@x.se", undefined, "alarm@x.se")).toBe(false);
  });
  it("never admits a missing email", () => {
    expect(isAdminEmail(null, undefined, "alarm@x.se")).toBe(false);
    expect(isAdminEmail("", "", "")).toBe(false);
  });
});
