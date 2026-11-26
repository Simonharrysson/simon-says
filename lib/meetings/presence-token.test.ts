import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issuePresenceToken, PRESENCE_TOKEN_TTL_SEC, verifyPresenceToken } from "./presence-token";

const key = randomBytes(32);
const T0 = Date.parse("2026-11-26T18:00:00Z");
const M = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";

describe("presence token (heartbeat while signed out)", () => {
  it("round-trips for its meeting and member", () => {
    expect(verifyPresenceToken(key, issuePresenceToken(key, M, U, T0), M, T0 + 60_000)).toBe(U);
  });

  it("outlives the 4 h meeting cap, then expires", () => {
    const t = issuePresenceToken(key, M, U, T0);
    expect(PRESENCE_TOKEN_TTL_SEC).toBeGreaterThan(4 * 3600);
    expect(verifyPresenceToken(key, t, M, T0 + 4 * 3600_000)).toBe(U);
    expect(verifyPresenceToken(key, t, M, T0 + (PRESENCE_TOKEN_TTL_SEC + 1) * 1000)).toBeNull();
  });

  it("is bound to the meeting, the key and its signature", () => {
    const t = issuePresenceToken(key, M, U, T0);
    expect(verifyPresenceToken(key, t, "33333333-3333-4333-8333-333333333333", T0)).toBeNull();
    expect(verifyPresenceToken(randomBytes(32), t, M, T0)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ m: M, u: "someone-else", e: 9e9 })).toString("base64url");
    expect(verifyPresenceToken(key, `${forged}.${sig}`, M, T0)).toBeNull();
    expect(verifyPresenceToken(key, `${body}.${sig}x`, M, T0)).toBeNull();
    expect(verifyPresenceToken(key, `${body}`, M, T0)).toBeNull();
    expect(verifyPresenceToken(key, null, M, T0)).toBeNull();
  });
});
