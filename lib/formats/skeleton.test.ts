import { describe, expect, it } from "vitest";
import { ENKEL, STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";
import { mergeRequiredItems, rolesFromSkeleton, skeletonBlocks, type SkeletonBlock } from "./skeleton";

const texts = (blocks: SkeletonBlock[], type: string) =>
  blocks.filter((b): b is Extract<SkeletonBlock, { text: string }> => b.type === type).map((b) => b.text);

describe("skeletonBlocks", () => {
  it("Veckomöte: title, empty info table, agenda, fixed items around Övriga punkter, both sections", () => {
    const blocks = skeletonBlocks(VECKOMOTE);
    expect(blocks[0]).toEqual({ type: "title", text: "Mötesprotokoll" });
    expect(blocks[1]).toEqual({
      type: "table",
      rows: [
        ["Datum", ""],
        ["Tid", ""],
        ["Närvarande", ""],
        ["Sekreterare", ""],
      ],
    });
    expect(blocks[2]).toEqual({ type: "heading", text: "Agenda" });
    expect(texts(blocks, "item")).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan", "Övriga punkter", "Övrigt"]);
    expect(texts(blocks, "heading")).toEqual(["Agenda", "Vad ska vi göra till nästa gång?", "Anteckningar"]);
    expect(texts(blocks, "para")).toEqual([]);
    // Doc order: items, then the two sections last.
    expect(blocks.slice(-2)).toEqual([
      { type: "heading", text: "Vad ska vi göra till nästa gång?" },
      { type: "heading", text: "Anteckningar" },
    ]);
  });

  it("Styrelseprotokoll: §-numbered items and three signature lines at the end", () => {
    const blocks = skeletonBlocks(STYRELSEPROTOKOLL);
    const items = texts(blocks, "item");
    expect(items[0]).toBe("§1 Mötets öppnande");
    expect(items).toHaveLength(9);
    expect(items.slice(-3)).toEqual(["§7 Övriga punkter", "§8 Övriga frågor", "§9 Mötets avslutande"]);
    expect(blocks.slice(-3)).toEqual([
      { type: "para", text: "Mötesordförande: ____________________" },
      { type: "para", text: "Mötessekreterare: ____________________" },
      { type: "para", text: "Justerare: ____________________" },
    ]);
    expect(texts(blocks, "heading")).toEqual(["Dagordning", "Att göra"]);
  });

  it("opts.items replaces the item list (with sub-items); opts.filled pre-fills table values", () => {
    const blocks = skeletonBlocks(VECKOMOTE, {
      items: [{ label: "Må-runda" }, { label: "Kommande event", sub: ["Sommarfest", "Workshop"] }],
      filled: { Datum: "2026-11-25", Sekreterare: "Elin Berglund" },
    });
    expect(blocks.filter((b) => b.type === "item" || b.type === "subitem")).toEqual([
      { type: "item", text: "Må-runda" },
      { type: "item", text: "Kommande event" },
      { type: "subitem", text: "Sommarfest" },
      { type: "subitem", text: "Workshop" },
    ]);
    expect(blocks[1]).toEqual({
      type: "table",
      rows: [
        ["Datum", "2026-11-25"],
        ["Tid", ""],
        ["Närvarande", ""],
        ["Sekreterare", "Elin Berglund"],
      ],
    });
  });

  it("a profile without a table or agenda heading still gets an agenda heading", () => {
    const blocks = skeletonBlocks(ENKEL);
    expect(blocks.some((b) => b.type === "table")).toBe(false);
    expect(blocks[1]).toEqual({ type: "heading", text: "Agenda" });
    expect(texts(blocks, "item")).toEqual(["Övriga punkter"]);
  });
});

describe("rolesFromSkeleton", () => {
  it("maps ag-<n> in skeleton order to the fixed roles, Övriga punkter → topic", () => {
    expect(rolesFromSkeleton(VECKOMOTE)).toEqual({
      "ag-1": "procedural",
      "ag-2": "checkin",
      "ag-3": "followup",
      "ag-4": "topic",
      "ag-5": "other",
    });
    const styrelse = rolesFromSkeleton(STYRELSEPROTOKOLL);
    expect(Object.keys(styrelse)).toHaveLength(9);
    expect(styrelse["ag-6"]).toBe("followup");
    expect(styrelse["ag-7"]).toBe("topic");
    expect(styrelse["ag-8"]).toBe("other");
    expect(styrelse["ag-9"]).toBe("procedural");
  });
});

describe("mergeRequiredItems (stadgar, Phase C)", () => {
  const withRequired = { ...STYRELSEPROTOKOLL, requiredItems: ["Val av justerare", "Fråga om mötets behöriga utlysande"] };

  it("adds only the required item no fixed label names, as procedural, after the last non-last procedural item", () => {
    const merged = mergeRequiredItems(withRequired);
    expect(merged).toHaveLength(STYRELSEPROTOKOLL.fixedAgendaItems.length + 1);
    const labels = merged.map((i) => i.label);
    expect(labels.filter((l) => l === "Val av justerare")).toHaveLength(1);
    const added = merged.find((i) => i.label === "Fråga om mötets behöriga utlysande")!;
    expect(added).toEqual({ key: "req-1", label: "Fråga om mötets behöriga utlysande", role: "procedural" });
    // After "Val av justerare" and the rest of the opening procedure, before the follow-up.
    const at = labels.indexOf(added.label);
    expect(at).toBeGreaterThan(labels.indexOf("Val av justerare"));
    expect(labels[at - 1]).toBe("Godkännande av dagordning");
    expect(labels[at + 1]).toBe("Föregående protokoll");
  });

  it("matches labels loosely (case, §, colon, whole-word containment) but never by synonym", () => {
    const loose = { ...STYRELSEPROTOKOLL, requiredItems: ["§4 val av JUSTERARE:", "Val av justerare och rösträknare", "Val av kassör"] };
    expect(mergeRequiredItems(loose).map((i) => i.label)).toContain("Val av kassör");
    expect(mergeRequiredItems(loose)).toHaveLength(STYRELSEPROTOKOLL.fixedAgendaItems.length + 1);
    // "Val av justerare" is not "Val av mötesordförande"; "mötets" alone is no match either.
    const veck = { ...VECKOMOTE, requiredItems: ["Val av justerare", "Mötets öppnande"] };
    expect(mergeRequiredItems(veck).map((i) => i.label)).toEqual([
      "Godkänn dagordning",
      "Val av justerare",
      "Mötets öppnande",
      "Må-runda",
      "Från förra veckan",
      "Övrigt",
    ]);
  });

  it("no required items: the fixed items unchanged; a profile without procedural items gets them first", () => {
    expect(mergeRequiredItems(STYRELSEPROTOKOLL)).toEqual(STYRELSEPROTOKOLL.fixedAgendaItems);
    expect(mergeRequiredItems({ ...ENKEL, requiredItems: ["Val av justerare"] })).toEqual([
      { key: "req-1", label: "Val av justerare", role: "procedural" },
    ]);
  });

  it("skeletonBlocks numbers the merged items §1..§10, signatures last; rolesFromSkeleton shifts with them", () => {
    const blocks = skeletonBlocks(withRequired);
    const items = texts(blocks, "item");
    expect(items).toEqual([
      "§1 Mötets öppnande",
      "§2 Val av mötesordförande",
      "§3 Val av mötessekreterare",
      "§4 Val av justerare",
      "§5 Godkännande av dagordning",
      "§6 Fråga om mötets behöriga utlysande",
      "§7 Föregående protokoll",
      "§8 Övriga punkter",
      "§9 Övriga frågor",
      "§10 Mötets avslutande",
    ]);
    expect(blocks.slice(-3).map((b) => b.type)).toEqual(["para", "para", "para"]);
    expect(blocks.at(-1)).toEqual({ type: "para", text: "Justerare: ____________________" });
    const roles = rolesFromSkeleton(withRequired);
    expect(Object.keys(roles)).toHaveLength(10);
    expect(roles["ag-6"]).toBe("procedural");
    expect(roles["ag-7"]).toBe("followup");
    expect(roles["ag-8"]).toBe("topic");
    expect(roles["ag-10"]).toBe("procedural");
  });
});
