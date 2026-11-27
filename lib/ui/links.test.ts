import { describe, expect, it } from "vitest";
import { isClientRoute } from "./links";

describe("isClientRoute", () => {
  it("app pages navigate client-side", () => {
    for (const href of ["/hem", "/orgs", "/orgs/abc?flik=oversikt", "/privat/mote/x", "/installningar", "/status", "/integritet#mejl", "/"]) {
      expect(isClientRoute(href), href).toBe(true);
    }
  });
  it("route handlers, sign-in, the live page and outside links load in full", () => {
    for (const href of ["/api/health", "/auth/callback", "/sprak?till=en", "/login", "/login?next=/hem", "/meetings/ny/abc", "/meetings/abc", "/join/xyz", "/mejl?t=1", "https://docs.google.com/x", "//evil.test", "#bjud-in", "", null, undefined]) {
      expect(isClientRoute(href), String(href)).toBe(false);
    }
  });
  it("only whole path segments count", () => {
    expect(isClientRoute("/meetingsarkiv")).toBe(true);
    expect(isClientRoute("/apis")).toBe(true);
  });
});
