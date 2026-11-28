import { beforeAll, describe, expect, it } from "vitest";
import { useTestEnv } from "@/test/env";
import { safeNextPath } from "@/lib/next-path";
import { checkInviteToken, inviteIdOf, inviteToken } from "./token";

describe("invite tokens (0063)", () => {
  beforeAll(useTestEnv);
  const id = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

  it("names the invite and is bound to its address", () => {
    const t = inviteToken(id, " Oskar@Exempel.se ");
    expect(t).toMatch(/^[0-9a-f]{32}[A-Za-z0-9_-]{22}$/);
    expect(inviteIdOf(t)).toBe(id);
    expect(checkInviteToken(t, id, "oskar@exempel.se")).toBe(true);
    // Another address (a forwarded mail can't be re-signed for someone else), another id, junk.
    expect(checkInviteToken(t, id, "eve@exempel.se")).toBe(false);
    expect(checkInviteToken(t, "0b1c2d3e-4f50-4617-8899-aabbccddeef0", "oskar@exempel.se")).toBe(false);
    expect(checkInviteToken(t, id, null)).toBe(false);
    const tampered = `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`;
    expect(checkInviteToken(tampered, id, "oskar@exempel.se")).toBe(false);
    expect(inviteIdOf("../../etc")).toBeNull();
  });

  it("survives the sign-in's next round trip", () => {
    const t = inviteToken(id, "oskar@exempel.se");
    expect(safeNextPath(`/in/${t}/klar`)).toBe(`/in/${t}/klar`);
  });
});
