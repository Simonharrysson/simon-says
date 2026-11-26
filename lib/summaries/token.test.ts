import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issuePresenceToken } from "@/lib/meetings/presence-token";
import { issueUnsubscribeToken, verifyUnsubscribeToken } from "./token";

const key = randomBytes(32);
const person = "6f1c2a1e-1111-4222-8333-944455556666";

describe("unsubscribe token", () => {
  it("round-trips the person id", () => {
    expect(verifyUnsubscribeToken(key, issueUnsubscribeToken(key, person))).toBe(person);
  });

  it("refuses another key, a changed body, junk and other token kinds", () => {
    const t = issueUnsubscribeToken(key, person);
    expect(verifyUnsubscribeToken(randomBytes(32), t)).toBeNull();
    const other = issueUnsubscribeToken(key, "6f1c2a1e-1111-4222-8333-944455550000");
    expect(verifyUnsubscribeToken(key, `${other.split(".")[0]}.${t.split(".")[1]}`)).toBeNull();
    for (const bad of [null, undefined, "", "a.b.c", "x".repeat(400), "abc"]) expect(verifyUnsubscribeToken(key, bad)).toBeNull();
    // A presence token (same key, another label) is not an unsubscribe token.
    expect(verifyUnsubscribeToken(key, issuePresenceToken(key, person, person, Date.now()))).toBeNull();
  });
});
