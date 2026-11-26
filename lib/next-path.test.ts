import { describe, expect, it } from "vitest";
import { loginErrorPath, safeNextPath, withParam } from "./next-path";

describe("safeNextPath", () => {
  it("keeps plain same-site paths", () => {
    expect(safeNextPath("/join/AbC-12_x")).toBe("/join/AbC-12_x");
    expect(safeNextPath("/orgs")).toBe("/orgs");
  });

  it("keeps a same-site path's query string and hash", () => {
    expect(safeNextPath("/orgs/abc?flik=installningar")).toBe("/orgs/abc?flik=installningar");
    expect(safeNextPath("/orgs/abc/installningar#sammanfattning")).toBe("/orgs/abc/installningar#sammanfattning");
    expect(safeNextPath("/a?b=1&c=%C3%A5#x")).toBe("/a?b=1&c=%C3%A5#x");
  });

  it.each([null, undefined, "", "orgs", "//evil.com", "/\\evil.com", "https://evil.com", "/a/../b.", "/%2F%2Fevil", "?x=1", "/a?b=\\evil", "/a?b=<script>", "/a#\\x", "/a?b= c", "//evil.com?x=1"])(
    "falls back to / for %s",
    (value) => {
      expect(safeNextPath(value)).toBe("/");
    },
  );
});

describe("withParam", () => {
  it("adds a parameter before the hash, with ? or &", () => {
    expect(withParam("/a", "kalender", "ok")).toBe("/a?kalender=ok");
    expect(withParam("/a?flik=installningar#k", "kalender", "ok")).toBe("/a?flik=installningar&kalender=ok#k");
  });
});

describe("loginErrorPath", () => {
  it("keeps a safe next and encodes it", () => {
    expect(loginErrorPath("drive", "/join/Ab-1")).toBe("/login?fel=drive&next=%2Fjoin%2FAb-1");
  });
  it("keeps a query string in next", () => {
    expect(loginErrorPath("kod", "/orgs/a?flik=installningar")).toBe("/login?fel=kod&next=%2Forgs%2Fa%3Fflik%3Dinstallningar");
  });
  it.each([null, "//evil.com", "https://evil.com", "/a?b=\\x"])("omits unsafe next %s", (v) => {
    expect(loginErrorPath("kod", v)).toBe("/login?fel=kod");
  });
});
