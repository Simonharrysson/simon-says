import type { FormatProfile } from "@/lib/formats/schema";
import type { SkeletonBlock } from "@/lib/formats/skeleton";
import type { DocsRequest } from "@/lib/google/docs";
import type { NotesTab } from "./tab";

// Skeleton blocks → Docs requests for a NEW, empty Doc tab (body = one empty paragraph at 1).
// Task A1 measurements this follows:
// - M8: an inserted paragraph inherits the style around it, so every non-normal paragraph gets an
//   explicit updateParagraphStyle;
// - M7c / tab handling: sub-items are written with leading tabs and ONE createParagraphBullets
//   over the whole item range removes the tabs (N tabs = level N) and makes one new list. Every
//   request that uses indices after that point would have to subtract the removed tabs, so the
//   bullets request comes after all paragraph styles, and the skeleton creates no named ranges
//   (anchorAgenda creates them from a fresh read);
// - M6: insertTable at an empty paragraph adds an undeletable empty paragraph before the table
//   and keeps one after it, so table indices are never computed: the table is inserted last (at
//   the lowest index, nothing after it in the batch), and its cells are filled in a second batch
//   from a fresh read (`skeletonTableFill`).

const NUMBERED_PRESET = "NUMBERED_DECIMAL_ALPHA_ROMAN";
const BULLET_PRESET = "BULLET_DISC_CIRCLE_SQUARE";

/** Batch 1: the text, its paragraph styles, the item list and (last) the empty table. */
export function skeletonRequests(tabId: string, blocks: SkeletonBlock[], numbering: FormatProfile["numbering"]): DocsRequest[] {
  const numbered = numbering === "numbered";
  // One line per block; a table is an empty placeholder paragraph.
  const lines = blocks.map((b) => {
    if (b.type === "table") return "";
    if (b.type === "subitem" && numbered) return `\t${b.text}`;
    return b.text;
  });
  for (const line of lines) if (line.includes("\n")) throw new Error("skeleton line contains a newline");

  const requests: DocsRequest[] = [];
  if (!lines.length) return requests;
  requests.push({ insertText: { text: lines.join("\n"), location: { index: 1, tabId } } });

  const range = (startIndex: number, endIndex: number) => ({ tabId, startIndex, endIndex });
  const style = (start: number, end: number, namedStyleType: string): DocsRequest => ({
    updateParagraphStyle: { range: range(start, end), paragraphStyle: { namedStyleType }, fields: "namedStyleType" },
  });

  const starts: number[] = [];
  let at = 1;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const ends = lines.map((l, i) => starts[i] + l.length);

  let placeholder: number | null = null;
  let tableRows = 0;
  // Item range for the numbered list (items + sub-items, consecutive in every skeleton).
  let listStart: number | null = null;
  let listEnd = 0;
  // Bullet runs of sub-items under heading items (paragraph / none numbering).
  const subRuns: { start: number; end: number }[] = [];

  blocks.forEach((b, i) => {
    const s = starts[i];
    const e = ends[i];
    switch (b.type) {
      case "title":
        requests.push(style(s, e, "HEADING_1"));
        break;
      case "heading":
        requests.push(style(s, e, "HEADING_2"));
        break;
      case "item":
        if (numbered) {
          listStart ??= s;
          listEnd = e;
        } else requests.push(style(s, e, "HEADING_3"));
        break;
      case "subitem":
        if (numbered) listEnd = e;
        else {
          const last = subRuns.at(-1);
          if (last && blocks[i - 1]?.type === "subitem") last.end = e;
          else subRuns.push({ start: s, end: e });
        }
        break;
      case "para":
        break;
      case "table":
        placeholder ??= s;
        tableRows = b.rows.length;
        break;
    }
  });
  // No tabs in these runs: nothing shifts.
  for (const run of subRuns) {
    requests.push({ createParagraphBullets: { range: range(run.start, run.end), bulletPreset: BULLET_PRESET } });
  }
  // Removes the sub-items' tabs: every index after listStart shifts, so nothing below uses one.
  if (listStart !== null) {
    requests.push({ createParagraphBullets: { range: range(listStart, listEnd), bulletPreset: NUMBERED_PRESET } });
  }
  // The table sits before the item list, so its index is unchanged by the removed tabs.
  if (placeholder !== null && tableRows > 0) {
    requests.push({ insertTable: { rows: tableRows, columns: 2, location: { index: placeholder, tabId } } });
  }
  return requests;
}

/**
 * Batch 2, from a fresh read after batch 1: the table rows' text (label | value), written from
 * the last cell to the first so earlier indices stay valid. Fills only empty cells.
 */
export function skeletonTableFill(tab: NotesTab, blocks: SkeletonBlock[]): DocsRequest[] {
  const table = blocks.find((b): b is Extract<SkeletonBlock, { type: "table" }> => b.type === "table");
  const docTable = tab.tables?.[0];
  if (!table || !docTable) return [];
  const writes: { at: number; text: string }[] = [];
  table.rows.forEach((row, r) => {
    row.forEach((text, c) => {
      const cell = docTable.rows[r]?.cells[c];
      if (cell && text && cell.text === "") writes.push({ at: cell.paragraphStart, text });
    });
  });
  writes.sort((a, b) => b.at - a.at);
  return writes.map((w) => ({ insertText: { text: w.text, location: { index: w.at, tabId: tab.tabId } } }));
}
