import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps plain same-site paths", () => {
    expect(safeNextPath("/join/AbC-12_x")).toBe("/join/AbC-12_x");
    expect(safeNextPath("/orgs")).toBe("/orgs");
  });

  it.each([null, undefined, "", "orgs", "//evil.com", "/\\evil.com", "https://evil.com", "/a?b=1", "/a/../b.", "/%2F%2Fevil"])(
    "falls back to / for %s",
    (value) => {
      expect(safeNextPath(value)).toBe("/");
    },
  );
});
