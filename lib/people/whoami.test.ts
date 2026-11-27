import { describe, expect, it } from "vitest";
import { afterJoinPath, claimable, isLinked, parseWhoamiError, suggestedName, whoamiError } from "./whoami";

const people = [
  { id: "p1", name: "Örjan Ek", role: null, member_user_id: null },
  { id: "p2", name: "Anna Berg", role: "Ordförande", member_user_id: "u-anna" },
  { id: "p3", name: "Åsa Lind", role: "Kassör", member_user_id: null, email: "asa@example.com" },
  { id: "p4", name: "Bertil Ås", role: null, member_user_id: null, email: "  ME@example.com " },
  { id: "p5", name: "Ceasar Al", role: null, member_user_id: null, email: "" },
];

describe("whoami", () => {
  it("isLinked: any person of the förening linked to the account", () => {
    expect(isLinked(people, "u-anna")).toBe(true);
    expect(isLinked(people, "u-me")).toBe(false);
  });

  it("claimable: free people without someone else's e-mail, in Swedish order", () => {
    expect(claimable(people, "me@example.com").map((p) => p.id)).toEqual(["p4", "p5", "p1"]);
    expect(claimable(people, null).map((p) => p.name)).toEqual(["Ceasar Al", "Örjan Ek"]);
    expect(claimable(people, "asa@example.com").map((p) => p.id)).toEqual(["p5", "p3", "p1"]);
  });

  it("afterJoinPath: welcome when linked, else the picker", () => {
    expect(afterJoinPath("o1", true)).toBe("/orgs/o1?valkommen=1");
    expect(afterJoinPath("o1", false)).toBe("/orgs/o1/vem");
  });

  it("maps refusals to ?fel= codes and back", () => {
    expect(whoamiError("ok")).toBeNull();
    expect(whoamiError("taken")).toBe("upptagen");
    expect(whoamiError("already")).toBe("redan");
    expect(whoamiError("invalid")).toBe("namn");
    expect(whoamiError("forbidden")).toBe("fel");
    expect(parseWhoamiError("roll")).toBe("roll");
    expect(parseWhoamiError("<script>")).toBeNull();
    expect(parseWhoamiError(undefined)).toBeNull();
  });

  it("suggestedName: the Google name when it is a string", () => {
    expect(suggestedName({ full_name: " Sara Nyström " })).toBe("Sara Nyström");
    expect(suggestedName({ name: "Erik" })).toBe("Erik");
    expect(suggestedName({ full_name: 42 })).toBe("");
    expect(suggestedName(null)).toBe("");
  });
});
