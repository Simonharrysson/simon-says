import type { docs_v1 } from "@googleapis/docs";

// Reading one Doc tab: paragraphs (body and table cells, in document order), tables, named
// ranges. Pure (no Google client), so the notes renderer and the agenda scanner share it.
// Task A1 measured: list text never holds the glyph, number or tab; a table's cells are only in
// the `table` element, so cell paragraphs are collected here and marked `inTable`.

/** Replaces any embedded object (chip, image, …) in paragraph text, so such edits never compare equal. */
export const OBJECT = "￼";

export interface Paragraph {
  start: number;
  end: number;
  /** Text including the trailing "\n"; non-text elements appear as OBJECT. */
  text: string;
  /** Holds a pending suggestion (suggested insertion, deletion or style change) by a human. */
  suggested: boolean;
  // The fields below are set by parseNotesTab; optional so hand-built tabs (tests) need not
  // carry them. Read them with the defaults noted.
  /** `namedStyleType`; default "NORMAL_TEXT". */
  style?: string;
  /** List membership; default null (not a list item). `level` is `nestingLevel` (missing = 0). */
  bullet?: { listId: string; level: number } | null;
  /** Every non-whitespace text run is bold; false when there is no such run. Default false. */
  bold?: boolean;
  /** A table cell paragraph: index into `NotesTab.tables`, row and column. Default null. */
  inTable?: { table: number; row: number; col: number } | null;
}

export interface TableCell {
  /** The cell element's own indices (`tableCell.startIndex/endIndex`). */
  start: number;
  end: number;
  /** The cell's paragraphs joined, trailing newline dropped ("" for an empty cell). */
  text: string;
  /** Start of the cell's first paragraph (cell.start + 1); an empty cell's paragraph is [s, s+1). */
  paragraphStart: number;
}

export interface Table {
  start: number;
  end: number;
  rows: { cells: TableCell[] }[];
}

export interface NotesTab {
  revisionId: string;
  tabId: string;
  /** Body paragraphs and table-cell paragraphs (marked `inTable`), in document order. */
  paragraphs: Paragraph[];
  /** name → one entry per named range with that name → its parts. */
  ranges: Map<string, { start: number; end: number }[][]>;
  /** Top-level tables in document order; default []. */
  tables?: Table[];
}

export const paraStyle = (p: Paragraph) => p.style ?? "NORMAL_TEXT";
export const paraBullet = (p: Paragraph) => p.bullet ?? null;
export const paraInTable = (p: Paragraph) => p.inTable ?? null;
/** Paragraph text without its trailing newline. */
export const paraLine = (p: Paragraph) => (p.text.endsWith("\n") ? p.text.slice(0, -1) : p.text);

function findTab(tabs: docs_v1.Schema$Tab[] | undefined, tabId: string): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const child = findTab(tab.childTabs, tabId);
    if (child) return child;
  }
  return undefined;
}

/** Any `suggested…` field with content (ids or change maps) on a Docs object. */
function hasSuggestion(obj: object): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("suggested") || v == null) continue;
    if (Array.isArray(v) ? v.length > 0 : typeof v === "object" ? Object.keys(v).length > 0 : true) return true;
  }
  return false;
}

function readParagraph(
  el: docs_v1.Schema$StructuralElement,
  inTable: Paragraph["inTable"],
): Paragraph | null {
  const para = el.paragraph;
  if (!para || el.startIndex == null || el.endIndex == null) return null;
  let text = "";
  let suggested = hasSuggestion(para);
  let boldRuns = 0;
  let plainRuns = 0;
  for (const pe of para.elements ?? []) {
    if (pe.textRun?.content != null) {
      text += pe.textRun.content;
      if (pe.textRun.content.trim()) {
        if (pe.textRun.textStyle?.bold) boldRuns++;
        else plainRuns++;
      }
    } else text += OBJECT.repeat(Math.max(1, (pe.endIndex ?? 0) - (pe.startIndex ?? 0)));
    const inner = pe.textRun ?? pe.inlineObjectElement ?? pe.autoText ?? pe.pageBreak ?? pe.footnoteReference ??
      pe.horizontalRule ?? pe.equation ?? pe.person ?? pe.richLink ?? pe.columnBreak ?? null;
    if (inner && hasSuggestion(inner)) suggested = true;
  }
  const bullet = para.bullet?.listId ? { listId: para.bullet.listId, level: para.bullet.nestingLevel ?? 0 } : null;
  return {
    start: el.startIndex,
    end: el.endIndex,
    text,
    suggested,
    style: para.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
    bullet,
    bold: boldRuns > 0 && plainRuns === 0,
    inTable,
  };
}

/** Body paragraphs, table cells and named ranges of one tab, from `documents.get` with includeTabsContent=true. */
export function parseNotesTab(doc: docs_v1.Schema$Document, tabId: string): NotesTab {
  const tab = findTab(doc.tabs, tabId);
  if (!tab?.documentTab) throw new Error(`tab ${tabId} not found (was includeTabsContent set?)`);
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];

  // Cell content: paragraphs (and, rarely, a nested table, read for its paragraphs only, marked
  // with the outer cell's coordinates).
  const readCell = (content: docs_v1.Schema$StructuralElement[], at: NonNullable<Paragraph["inTable"]>): Paragraph[] => {
    const out: Paragraph[] = [];
    for (const el of content) {
      const p = readParagraph(el, at);
      if (p) out.push(p);
      for (const row of el.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) out.push(...readCell(cell.content ?? [], at));
      }
    }
    return out;
  };

  for (const el of tab.documentTab.body?.content ?? []) {
    const p = readParagraph(el, null);
    if (p) {
      paragraphs.push(p);
      continue;
    }
    if (!el.table || el.startIndex == null || el.endIndex == null) continue;
    const t = tables.length;
    const table: Table = { start: el.startIndex, end: el.endIndex, rows: [] };
    tables.push(table);
    (el.table.tableRows ?? []).forEach((row, r) => {
      const cells: TableCell[] = [];
      (row.tableCells ?? []).forEach((cell, c) => {
        const paras = readCell(cell.content ?? [], { table: t, row: r, col: c });
        paragraphs.push(...paras);
        const joined = paras.map((x) => x.text).join("");
        const start = cell.startIndex ?? paras[0]?.start ?? 0;
        cells.push({
          start,
          end: cell.endIndex ?? paras[paras.length - 1]?.end ?? start,
          text: joined.endsWith("\n") ? joined.slice(0, -1) : joined,
          paragraphStart: paras[0]?.start ?? start + 1,
        });
      });
      table.rows.push({ cells });
    });
  }

  const ranges = new Map<string, { start: number; end: number }[][]>();
  for (const [name, group] of Object.entries(tab.documentTab.namedRanges ?? {})) {
    const entries = (group.namedRanges ?? []).map((nr) =>
      (nr.ranges ?? []).map((r) => ({ start: r.startIndex ?? 0, end: r.endIndex ?? 0 })),
    );
    if (entries.length) ranges.set(name, entries);
  }
  return { revisionId: doc.revisionId ?? "", tabId, paragraphs, ranges, tables };
}

/** The table cell that contains `index` (cell element bounds), or null. For whole-cell text diffs. */
export function cellAt(tab: NotesTab, index: number): (TableCell & { table: number; row: number; col: number }) | null {
  for (const [t, table] of (tab.tables ?? []).entries()) {
    if (index < table.start || index >= table.end) continue;
    for (const [r, row] of table.rows.entries()) {
      for (const [c, cell] of row.cells.entries()) {
        if (index >= cell.start && index < cell.end) return { ...cell, table: t, row: r, col: c };
      }
    }
  }
  return null;
}
