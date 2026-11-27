import { describe, expect, it } from "vitest";
import { boardRows, cleanEmail } from "./board";

const members = [
  { userId: "u1", email: "anna.berg@example.com", role: "admin" as const },
  { userId: "u2", email: "erik.lund@example.com", role: "member" as const },
];

describe("boardRows", () => {
  it("one list: linked people show their account, invited and name-only people their state, unnamed members last", () => {
    const rows = boardRows(
      [
        { id: "p1", name: "Anna Berg", role: "Ordförande", member_user_id: "u1", voice_consent_at: "2026-11-26T10:00:00Z" },
        { id: "p2", name: "Sara Nyström", role: "Kassör", email: "sara@example.com", member_user_id: null },
        { id: "p3", name: "Johan Ek", member_user_id: null },
      ],
      members,
    );
    expect(rows.map((r) => [r.personId, r.name, r.status, r.email, r.voiceConsent])).toEqual([
      ["p1", "Anna Berg", "account", "anna.berg@example.com", true],
      ["p2", "Sara Nyström", "invited", "sara@example.com", false],
      ["p3", "Johan Ek", "name", null, false],
      [null, null, "account", "erik.lund@example.com", false],
    ]);
  });

  it("a link to someone no longer a member counts as not linked", () => {
    const [row] = boardRows([{ id: "p1", name: "Anna", member_user_id: "gone" }], []);
    expect(row.status).toBe("name");
  });
});

describe("cleanEmail", () => {
  it("accepts and lowercases plausible addresses only", () => {
    expect(cleanEmail("  Sara@Example.com ")).toBe("sara@example.com");
    expect(cleanEmail("sara")).toBeNull();
    expect(cleanEmail("a b@c.se")).toBeNull();
    expect(cleanEmail(3)).toBeNull();
  });

  it("marks a recent self link on a linked row only (0051)", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const members = [{ userId: "u1", email: "anna@example.com", role: "member" as const }];
    const [fresh] = boardRows([{ id: "p1", name: "Anna", member_user_id: "u1", self_linked_at: "2026-11-27T10:00:00Z" }], members, now);
    expect(fresh.selfLinkedAt).toBe("2026-11-27T10:00:00Z");
    const [old] = boardRows([{ id: "p1", name: "Anna", member_user_id: "u1", self_linked_at: "2026-11-01T10:00:00Z" }], members, now);
    expect(old.selfLinkedAt).toBeNull();
    const [gone] = boardRows([{ id: "p1", name: "Anna", member_user_id: null, self_linked_at: "2026-11-30T10:00:00Z" }], members, now);
    expect(gone.selfLinkedAt).toBeNull();
  });
});
