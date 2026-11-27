import { describe, expect, it } from "vitest";
import { canvasPeople } from "./people";

describe("canvasPeople", () => {
  it("person rows keep their place; accounts without a row come unplaced", () => {
    const out = canvasPeople(
      [
        { id: "p1", name: "Anna", member_user_id: "u1", group_id: "g1" },
        { id: "p2", name: "Bo", member_user_id: null, group_id: null },
      ],
      [
        { userId: "u1", email: "anna@x.se", role: "admin" },
        { userId: "u2", email: "kim@x.se", role: "member" },
      ],
      "u2",
    );
    expect(out).toEqual([
      { key: "p:p1", personId: "p1", userId: "u1", name: "Anna", email: "anna@x.se", groupId: "g1", admin: true, you: false },
      { key: "p:p2", personId: "p2", userId: null, name: "Bo", email: null, groupId: null, admin: false, you: false },
      { key: "u:u2", personId: null, userId: "u2", name: "kim@x.se", email: "kim@x.se", groupId: null, admin: false, you: true },
    ]);
  });
});
