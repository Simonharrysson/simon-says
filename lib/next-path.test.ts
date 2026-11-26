import { describe, expect, it } from "vitest";
import { loginErrorPath, safeNextPath } from "./next-path";

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

describe("loginErrorPath", () => {
  it("keeps a safe next and encodes it", () => {
    expect(loginErrorPath("drive", "/join/Ab-1")).toBe("/login?fel=drive&next=%2Fjoin%2FAb-1");
  });
  it.each([null, "//evil.com", "https://evil.com", "/a?b=1"])("omits unsafe next %s", (v) => {
    expect(loginErrorPath("kod", v)).toBe("/login?fel=kod");
  });
});
