import { describe, expect, it } from "vitest";
import { FormatProfileSchema, parseProfile } from "./schema";
import { ENKEL, FORMAT_NAMES, STANDARD, STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";

describe("standard formats", () => {
  it.each([
    ["VECKOMOTE", VECKOMOTE],
    ["STYRELSEPROTOKOLL", STYRELSEPROTOKOLL],
    ["ENKEL", ENKEL],
  ])("%s passes the schema", (_n, p) => {
    expect(FormatProfileSchema.safeParse(p).success).toBe(true);
    expect(parseProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("STANDARD maps kinds to the constants, with names", () => {
    expect(STANDARD).toEqual({ veckomote: VECKOMOTE, styrelseprotokoll: STYRELSEPROTOKOLL, enkel: ENKEL });
    expect(FORMAT_NAMES.learned).toBe("Eget");
  });

  it("Styrelseprotokoll is complete: 8 fixed items, § numbering, prefix and tone set", () => {
    expect(STYRELSEPROTOKOLL.fixedAgendaItems).toHaveLength(8);
    expect(STYRELSEPROTOKOLL.numbering).toBe("paragraph");
    expect(STYRELSEPROTOKOLL.decisionPrefix).toBe("Beslut:");
    expect(STYRELSEPROTOKOLL.taskStyle).toBe("role-first");
    expect(STYRELSEPROTOKOLL.tone).toBe("full-sentences");
    expect(STYRELSEPROTOKOLL.requiredItems).toEqual([]);
  });
});

describe("FormatProfileSchema", () => {
  const withItems = (fixedAgendaItems: unknown[]) => ({ ...VECKOMOTE, fixedAgendaItems });

  it("rejects two checkin items", () => {
    const items = [
      { key: "a", label: "Må-runda", role: "checkin" },
      { key: "b", label: "Incheckning", role: "checkin" },
    ];
    expect(FormatProfileSchema.safeParse(withItems(items)).success).toBe(false);
  });

  it("rejects two followup items and duplicate keys", () => {
    expect(
      FormatProfileSchema.safeParse(
        withItems([
          { key: "a", label: "X", role: "followup" },
          { key: "b", label: "Y", role: "followup" },
        ]),
      ).success,
    ).toBe(false);
    expect(
      FormatProfileSchema.safeParse(
        withItems([
          { key: "a", label: "X", role: "topic" },
          { key: "a", label: "Y", role: "topic" },
        ]),
      ).success,
    ).toBe(false);
  });

  it("rejects an 81-character label and accepts 80", () => {
    expect(FormatProfileSchema.safeParse({ ...VECKOMOTE, title: "x".repeat(81) }).success).toBe(false);
    expect(FormatProfileSchema.safeParse({ ...VECKOMOTE, title: "x".repeat(80) }).success).toBe(true);
  });

  it("enforces the list limits", () => {
    expect(FormatProfileSchema.safeParse({ ...VECKOMOTE, infoTable: Array(9).fill("Datum") }).success).toBe(false);
    expect(FormatProfileSchema.safeParse({ ...VECKOMOTE, requiredItems: Array(16).fill("X") }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, label: "X", role: "topic" }));
    expect(FormatProfileSchema.safeParse(withItems(many)).success).toBe(false);
  });

  it("parseProfile returns null for junk", () => {
    expect(parseProfile({})).toBeNull();
    expect(parseProfile(null)).toBeNull();
  });
});
