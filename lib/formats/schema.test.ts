import { describe, expect, it } from "vitest";
import { FormatProfileSchema, hidesCheckin, meetingRoles, parseProfile } from "./schema";
import { ARSMOTE, ENKEL, FORMAT_NAMES, STANDARD, STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";
import { skeletonBlocks } from "./skeleton";

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
    expect(STANDARD).toEqual({ veckomote: VECKOMOTE, styrelseprotokoll: STYRELSEPROTOKOLL, enkel: ENKEL, arsmote: ARSMOTE });
    expect(FORMAT_NAMES.learned).toBe("Ert format");
    expect(FORMAT_NAMES.arsmote).toBe("Årsmöte");
  });

  it("Årsmöte is a valid profile with the design's standard agenda, § numbered, no Från förra veckan", () => {
    expect(parseProfile(ARSMOTE)).toEqual(ARSMOTE);
    expect(ARSMOTE.fixedAgendaItems.some((i) => i.role === "followup")).toBe(false);
    const items = skeletonBlocks(ARSMOTE).filter((b) => b.type === "item").map((b) => (b as { text: string }).text);
    expect(items[0]).toBe("§1 Mötets öppnande");
    expect(items).toContain("§5 Fråga om mötet är stadgeenligt utlyst");
    expect(items.at(-2)).toBe("§13 Övriga frågor");
    expect(items.at(-1)).toBe("§14 Mötets avslutande");
  });

  it("Styrelseprotokoll is complete: 8 fixed items, § numbering, prefix and tone set", () => {
    expect(STYRELSEPROTOKOLL.fixedAgendaItems).toHaveLength(8);
    expect(STYRELSEPROTOKOLL.numbering).toBe("paragraph");
    expect(STYRELSEPROTOKOLL.decisionPrefix).toBe("Beslut:");
    expect(STYRELSEPROTOKOLL.taskStyle).toBe("role-first");
    expect(STYRELSEPROTOKOLL.tone).toBe("full-sentences");
    expect(STYRELSEPROTOKOLL.requiredItems).toEqual([]);
  });

  it("Styrelseprotokoll: Föregående protokoll is an 'other' item (R-C1), so the format has no followup item", () => {
    expect(STYRELSEPROTOKOLL.fixedAgendaItems.find((i) => i.key === "previous")).toEqual({
      key: "previous",
      label: "Föregående protokoll",
      role: "other",
    });
    expect(STYRELSEPROTOKOLL.fixedAgendaItems.some((i) => i.role === "followup")).toBe(false);
    // Veckomöte keeps its Från förra veckan.
    expect(VECKOMOTE.fixedAgendaItems.find((i) => i.key === "followup")?.role).toBe("followup");
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

describe("formatLabel (final review R3-I2)", () => {
  it("names standard, learned and custom versions", async () => {
    const { formatLabel } = await import("./standard");
    const at = "2026-11-25T10:00:00Z";
    expect(formatLabel({ kind: "styrelseprotokoll", createdAt: at, custom: false, requiredCount: 0 })).toBe("Styrelseprotokoll");
    expect(formatLabel({ kind: "styrelseprotokoll", createdAt: at, custom: true, requiredCount: 3 })).toBe("Styrelseprotokoll med stadgarnas punkter (2026-11-25)");
    expect(formatLabel({ kind: "veckomote", createdAt: at, custom: true, requiredCount: 0 })).toBe("Veckomöte, anpassat (2026-11-25)");
    expect(formatLabel({ kind: "learned", createdAt: at, custom: true, requiredCount: 0 })).toBe("Ert format (inlärt 25 nov)");
    expect(formatLabel({ kind: "learned", createdAt: at, custom: true, requiredCount: 0, name: "Styrelsen 2026" })).toBe("Styrelsen 2026");
  });
});

describe("Må-runda hiding (opt-in)", () => {
  const roles = { "ag-1": "procedural", "ag-2": "checkin", "ag-3": "followup", "ag-4": "topic" } as const;
  it("is off for every standard format and for a stored profile without the flag", () => {
    for (const p of Object.values(STANDARD)) expect(hidesCheckin(p)).toBe(false);
    expect(hidesCheckin(parseProfile(JSON.parse(JSON.stringify(VECKOMOTE)))!)).toBe(false);
  });
  it("off: the Må-runda becomes an ordinary (procedural) item; on: the roles are kept", () => {
    expect(meetingRoles(roles, VECKOMOTE)).toEqual({ ...roles, "ag-2": "procedural" });
    expect(meetingRoles(roles, { hideCheckin: false })).toEqual({ ...roles, "ag-2": "procedural" });
    expect(meetingRoles(roles, { ...VECKOMOTE, hideCheckin: true })).toEqual(roles);
  });
});

describe("format name (optional)", () => {
  it("round-trips through the editor and is left out when empty", async () => {
    const { profileToEditor, editorToProfile } = await import("./editor");
    const { VECKOMOTE } = await import("./standard");
    const s = profileToEditor({ ...VECKOMOTE, name: "Styrelsen 2026" });
    const r = editorToProfile(s);
    expect(r.ok && r.profile.name).toBe("Styrelsen 2026");
    const r2 = editorToProfile({ ...s, name: "  " });
    expect(r2.ok && "name" in r2.profile).toBe(false);
  });
});
