import { describe, expect, it } from "vitest";
import { docAccessFor } from "./access-state";

describe("docAccessFor", () => {
  const meetings = [
    { id: "m1", started_by: "me" },
    { id: "m2", started_by: "anna" },
    { id: "m3", started_by: "anna" },
    { id: "m4", started_by: null },
  ];

  it("a link only for the starter and recorded shares; others ask Simon Says to share", () => {
    expect(docAccessFor(meetings, "me", new Set(["m3"]))).toEqual({ m1: "open", m2: "request", m3: "open", m4: "request" });
  });

  it("nothing is open for a viewer without an id, nor without recorded shares (database without 0030)", () => {
    expect(docAccessFor(meetings, null, new Set())).toEqual({ m1: "request", m2: "request", m3: "request", m4: "request" });
  });

  it("the förening's own agenda Doc: ask the starter (never shared by Simon Says); ours, e.g. the Testmöte agenda, can be requested", () => {
    const agenda = [
      { id: "a1", started_by: "anna", agenda_doc: true },
      { id: "a2", started_by: "anna", agenda_doc: true, app_created_doc: false },
      { id: "a3", started_by: "anna", agenda_doc: true, app_created_doc: true },
      { id: "a4", started_by: "me", agenda_doc: true, app_created_doc: false },
    ];
    expect(docAccessFor(agenda, "me", new Set())).toEqual({ a1: "ask", a2: "ask", a3: "request", a4: "open" });
  });
});
