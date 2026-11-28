import { describe, expect, it } from "vitest";
import { isAdminPath, mayOpenAdmin } from "./gate";

describe("mayOpenAdmin", () => {
  const env = { ADMIN_EMAILS: "simon@x.se, ops@x.se" };
  it("admits only the ADMIN_EMAILS list, case-insensitively", () => {
    expect(mayOpenAdmin("Simon@X.se", env)).toBe(true);
    expect(mayOpenAdmin("ops@x.se", env)).toBe(true);
    expect(mayOpenAdmin("someone@x.se", env)).toBe(false);
  });
  it("refuses a missing e-mail", () => {
    expect(mayOpenAdmin(null, env)).toBe(false);
    expect(mayOpenAdmin("", env)).toBe(false);
  });
  it("fails closed without ADMIN_EMAILS (no ALARM_EMAIL fallback)", () => {
    expect(mayOpenAdmin("alarm@x.se", {})).toBe(false);
    expect(mayOpenAdmin("alarm@x.se", { ADMIN_EMAILS: " , " })).toBe(false);
    expect(mayOpenAdmin("", { ADMIN_EMAILS: "" })).toBe(false);
  });
});

describe("isAdminPath", () => {
  it("matches /admin and below only", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/x")).toBe(true);
    expect(isAdminPath("/administration")).toBe(false);
    expect(isAdminPath("/orgs/admin")).toBe(false);
  });
});
