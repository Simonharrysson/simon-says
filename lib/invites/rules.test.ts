import { describe, expect, it } from "vitest";
import { canResend, parseEmails, type InviteRow } from "./rules";

describe("parseEmails", () => {
  it("splits on commas, semicolons, spaces and newlines; lowercases and dedupes", () => {
    const p = parseEmails("Anna@Example.com, bo@example.com;\ncecilia@example.org  anna@example.com\n\n");
    expect(p.valid).toEqual(["anna@example.com", "bo@example.com", "cecilia@example.org"]);
    expect(p.invalid).toEqual([]);
    expect(p.duplicates).toEqual(["anna@example.com"]);
  });

  it("takes the address out of 'Name <address>' and mailto:", () => {
    const p = parseEmails("Anna Berg <anna@example.com>, Bo Ek <BO@example.com>\nmailto:cecilia@example.org");
    expect(p.valid).toEqual(["anna@example.com", "bo@example.com", "cecilia@example.org"]);
    expect(p.invalid).toEqual([]);
  });

  it("reports what isn't an address", () => {
    const p = parseEmails("anna@example.com, anna@, inte-en-adress, @example.com");
    expect(p.valid).toEqual(["anna@example.com"]);
    expect(p.invalid).toEqual(["anna@", "inte-en-adress", "@example.com"]);
  });

  it("empty input", () => {
    expect(parseEmails(" \n , ")).toEqual({ valid: [], invalid: [], duplicates: [] });
  });
});

describe("canResend", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const row = (r: Partial<InviteRow>): InviteRow => ({ email: "a@example.com", status: "sent", lastSentAt: null, acceptedAt: null, recentSends: 1, nextResendAt: null, ...r });

  it("one resend in 24 h, then not until the oldest send is a day old", () => {
    expect(canResend(row({ recentSends: 1 }), now)).toBe(true);
    expect(canResend(row({ recentSends: 2, nextResendAt: "2026-11-26T18:00:00Z" }), now)).toBe(false);
    expect(canResend(row({ recentSends: 2, nextResendAt: "2026-11-26T11:00:00Z" }), now)).toBe(true);
  });

  it("a failed send can be tried again; accepted and in-flight cannot", () => {
    expect(canResend(row({ status: "failed", recentSends: 0 }), now)).toBe(true);
    expect(canResend(row({ status: "accepted" }), now)).toBe(false);
    expect(canResend(row({ status: "sending" }), now)).toBe(false);
  });
});
