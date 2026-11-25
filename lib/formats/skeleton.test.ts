import { describe, expect, it } from "vitest";
import { ENKEL, STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";
import { rolesFromSkeleton, skeletonBlocks, type SkeletonBlock } from "./skeleton";

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
