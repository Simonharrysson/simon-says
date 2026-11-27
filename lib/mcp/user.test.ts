import { describe, expect, it } from "vitest";
import { usableUser } from "./user";

describe("usableUser", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  type U = { id: string; banned_until?: string; deleted_at?: string };
  it("refuses deleted and currently banned accounts", () => {
    expect(usableUser<U>({ id: "a" }, now)).toEqual({ id: "a" });
    expect(usableUser<U>({ id: "a", deleted_at: "2026-11-01T00:00:00Z" }, now)).toBeNull();
    expect(usableUser<U>({ id: "a", banned_until: "2027-01-01T00:00:00Z" }, now)).toBeNull();
    expect(usableUser<U>({ id: "a", banned_until: "2026-01-01T00:00:00Z" }, now)).toEqual({ id: "a", banned_until: "2026-01-01T00:00:00Z" });
  });
});
