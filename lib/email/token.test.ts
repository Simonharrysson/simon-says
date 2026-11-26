import { beforeAll, describe, expect, it } from "vitest";
import { useTestEnv } from "@/test/env";
import { checkEmailPrefsToken, emailPrefsToken, emailPrefsUrl, listUnsubscribeHeaders } from "./token";

describe("e-mail preference links", () => {
  beforeAll(useTestEnv);

  it("round-trips the (cleaned) address", () => {
    const t = emailPrefsToken("  Anna.Berg@Example.com ");
    expect(checkEmailPrefsToken(t)).toBe("anna.berg@example.com");
  });

  it("rejects tampering, other addresses and junk", () => {
    const t = emailPrefsToken("anna@example.com");
    const [, sig] = t.split(".");
    const other = `${Buffer.from("erik@example.com").toString("base64url")}.${sig}`;
    expect(checkEmailPrefsToken(other)).toBeNull();
    expect(checkEmailPrefsToken(`${t}x`)).toBeNull();
    expect(checkEmailPrefsToken("")).toBeNull();
    expect(checkEmailPrefsToken(undefined)).toBeNull();
    expect(checkEmailPrefsToken("a".repeat(1000))).toBeNull();
    expect(() => emailPrefsToken("not-an-address")).toThrow();
  });

  it("builds the page URL and one-click headers on APP_URL", () => {
    const url = new URL(emailPrefsUrl("anna@example.com", "meeting_summary"));
    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe("/mejl");
    expect(url.searchParams.get("k")).toBe("meeting_summary");
    expect(checkEmailPrefsToken(url.searchParams.get("t"))).toBe("anna@example.com");
    const h = listUnsubscribeHeaders("anna@example.com", "invite");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(h["List-Unsubscribe"]).toMatch(/^<https:\/\/example\.com\/api\/mejl\/avsluta\?t=[^&]+&k=invite>$/);
  });
});
