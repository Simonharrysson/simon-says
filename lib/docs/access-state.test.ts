import { describe, expect, it } from "vitest";
import { docAccessFor } from "./access-state";

describe("docAccessFor", () => {
  const meetings = [
    { id: "m1", started_by: "me" },
    { id: "m2", started_by: "anna" },
    { id: "m3", started_by: "anna" },
    { id: "m4", started_by: null },
  ];

  it("a link only for the starter and recorded shares; everyone else asks", () => {
    expect(docAccessFor(meetings, "me", new Set(["m3"]))).toEqual({ m1: "open", m2: "request", m3: "open", m4: "request" });
  });

  it("nothing is open for a viewer without an id, nor without recorded shares (database without 0030)", () => {
    expect(docAccessFor(meetings, null, new Set())).toEqual({ m1: "request", m2: "request", m3: "request", m4: "request" });
  });
});
