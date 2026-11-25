import { describe, expect, it } from "vitest";
import { scanAgenda } from "@/lib/agenda/scan";
import { rolesFromSkeleton, skeletonBlocks } from "@/lib/formats/skeleton";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";
import { apply, docOf, paraEl, TAB } from "@/test/docsim";
import { skeletonRequests, skeletonTableFill } from "./skeleton";
import { paraBullet, paraInTable, paraLine, paraStyle, parseNotesTab } from "./tab";

/** A new Doc (one empty paragraph), both skeleton batches applied, read back. */
function build(blocks: ReturnType<typeof skeletonBlocks>, numbering: "numbered" | "paragraph" | "none") {
  const doc = docOf([paraEl("")]);
  apply(doc, skeletonRequests(TAB, blocks, numbering));
  apply(doc, skeletonTableFill(parseNotesTab(doc, TAB), blocks));
  return parseNotesTab(doc, TAB);
}

describe("skeletonRequests", () => {
  it("one insert at 1, styles before the one list request, the table last", () => {
    const reqs = skeletonRequests(TAB, skeletonBlocks(VECKOMOTE), "numbered");
    expect(reqs[0].insertText?.location).toEqual({ index: 1, tabId: TAB });
    const kinds = reqs.map((r) => Object.keys(r)[0]);
    expect(kinds.filter((k) => k === "createParagraphBullets")).toHaveLength(1);
    expect(kinds.lastIndexOf("updateParagraphStyle")).toBeLessThan(kinds.indexOf("createParagraphBullets"));
    expect(kinds.at(-1)).toBe("insertTable");
    expect(reqs.some((r) => r.createNamedRange)).toBe(false);
    for (const r of reqs) expect(JSON.stringify(r)).toContain(TAB);
  });

  it("Veckomöte skeleton scans as 5 list items whose keys match rolesFromSkeleton", () => {
    const tab = build(skeletonBlocks(VECKOMOTE), "numbered");
    const body = tab.paragraphs.filter((p) => !paraInTable(p));
    expect(paraStyle(body[0])).toBe("HEADING_1");
    expect(paraLine(body[0])).toBe("Mötesprotokoll");
    const scan = scanAgenda(tab, VECKOMOTE);
    expect(scan.items.map((i) => [i.key, i.label, i.kind, i.level])).toEqual([
      ["ag-1", "Godkänn dagordning", "list", 0],
      ["ag-2", "Må-runda", "list", 0],
      ["ag-3", "Från förra veckan", "list", 0],
      ["ag-4", "Övriga punkter", "list", 0],
      ["ag-5", "Övrigt", "list", 0],
    ]);
    expect(Object.keys(rolesFromSkeleton(VECKOMOTE))).toEqual(scan.items.map((i) => i.key));
    expect(new Set(scan.items.map((i) => paraBullet(body.find((p) => p.start === i.paraStart)!)!.listId)).size).toBe(1);
    expect(scan.tasksHeading?.text).toBe("Vad ska vi göra till nästa gång?");
    expect(scan.notesHeading?.text).toBe("Anteckningar");
    expect(scan.info.map((c) => [c.field, c.valueCell.empty])).toEqual([
      ["Datum", true],
      ["Tid", true],
      ["Närvarande", true],
      ["Sekreterare", true],
    ]);
  });

  it("sub-items: tabs removed, level 1 of the same new list, read as sub-points", () => {
    const blocks = skeletonBlocks(VECKOMOTE, {
      items: [{ label: "Må-runda" }, { label: "Kommande event", sub: ["Sommarfest", "Workshop"] }, { label: "Övrigt" }],
      filled: { Datum: "2026-11-25" },
    });
    const tab = build(blocks, "numbered");
    const scan = scanAgenda(tab, VECKOMOTE);
    expect(scan.items.map((i) => i.label)).toEqual(["Må-runda", "Kommande event", "Övrigt"]);
    expect(scan.items[1].humanText).toBe("Sommarfest\nWorkshop");
    const sub = tab.paragraphs.find((p) => paraLine(p) === "Sommarfest")!;
    expect(paraBullet(sub)?.level).toBe(1);
    expect(tab.paragraphs.some((p) => p.text.includes("\t"))).toBe(false);
    expect(scan.info.find((c) => c.field === "Datum")?.valueCell.text).toBe("2026-11-25");
  });

  it("Styrelseprotokoll skeleton scans as 9 §-heading items; signatures after the tasks heading", () => {
    const tab = build(skeletonBlocks(STYRELSEPROTOKOLL), "paragraph");
    const scan = scanAgenda(tab, STYRELSEPROTOKOLL);
    expect(scan.items).toHaveLength(9);
    expect(scan.items[0].label).toBe("Mötets öppnande");
    expect(scan.items.every((i) => i.kind === "heading")).toBe(true);
    expect(scan.items.at(-1)!.label).toBe("Mötets avslutande");
    expect(scan.tasksHeading?.text).toBe("Att göra");
    expect(scan.notesHeading).toBeNull();
    const lines = tab.paragraphs.filter((p) => !paraInTable(p)).map(paraLine);
    expect(lines.slice(-4)).toEqual(["Att göra", "Mötesordförande: ____________________", "Mötessekreterare: ____________________", "Justerare: ____________________"]);
    expect(scan.info.map((c) => c.field)).toEqual(["Datum", "Tid", "Plats", "Närvarande"]);
  });
});
