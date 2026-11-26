import { describe, expect, it } from "vitest";
import { addItem, bodyItems, withPending } from "./edit";
import { normaliseItems, PrepareBodySchema } from "./draft";
import type { DraftItem } from "./types";

// Hook & Look, 2026-12-02: "Rekrytering" typed in "Lägg till punkt", then "Skapa dagordning"
// without "Lägg till": the point never reached the server.

const draft: DraftItem[] = [
  { id: "std:approve", label: "Godkänn dagordning", role: "procedural", source: "standing", on: true },
  { id: "std:checkin", label: "Må-runda", role: "checkin", source: "standing", on: true },
  { id: "std:followup", label: "Från förra veckan", role: "followup", source: "standing", on: true, tasks: [] },
  { id: "topic:sponsring", label: "Sponsring", role: "topic", source: "suggested", on: false, meetings: 3 },
  { id: "std:other", label: "Övrigt", role: "other", source: "standing", on: true, last: true },
];

describe("withPending", () => {
  it("puts a typed but not added point on the agenda, before Övrigt", () => {
    const out = withPending(draft, "  Rekrytering ", "add:x");
    expect(out.filter((i) => i.on).map((i) => i.label)).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan", "Rekrytering", "Övrigt"]);
    expect(out.find((i) => i.id === "add:x")).toMatchObject({ source: "added", role: "topic", on: true });
  });

  it("leaves the draft as it is when the field is empty", () => {
    expect(withPending(draft, "   ", "add:x")).toBe(draft);
  });

  it("reaches the server: the body validates and the point survives normaliseItems", () => {
    const body = { type: "veckomote", date: "2026-12-02", time: "12:00", items: bodyItems(withPending(draft, "Rekrytering", "add:x")) };
    const parsed = PrepareBodySchema.parse(body);
    const items = normaliseItems(parsed.items, draft)!;
    expect(items.filter((i) => i.on).map((i) => i.label)).toContain("Rekrytering");
  });
});

describe("addItem (the Lägg till button and Enter)", () => {
  it("shows the new point at once, on the agenda before the last items", () => {
    const out = addItem(draft, "Fest", "add:f");
    const on = out.filter((i) => i.on).map((i) => i.id);
    expect(on.indexOf("add:f")).toBe(on.indexOf("std:other") - 1);
  });
});

describe("bodyItems", () => {
  it("drops an added point whose label was emptied and never sends an empty label", () => {
    const items: DraftItem[] = [...draft, { id: "add:e", label: "  ", role: "topic", source: "added", on: true }, { ...draft[1], id: "std:x", label: "" }];
    const out = bodyItems(items);
    expect(out.some((i) => i.id === "add:e")).toBe(false);
    expect(out.find((i) => i.id === "std:x")).toMatchObject({ label: "Punkt", on: false });
  });
});
