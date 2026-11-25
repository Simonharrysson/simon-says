import type { docs_v1 } from "@googleapis/docs";
import { scanAgenda } from "@/lib/agenda/scan";
import { isNumberedGlyph, listGlyph, paraBullet, paraInTable, paraLine, paraStyle, parseNotesTab, type Paragraph } from "@/lib/docs/tab";
import type { FormatProfile } from "./schema";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";

// The STRUCTURE of a förening's old minutes or template, for learning its format (spec "Learning
// a format", Task B1). Privacy is the point of this file: what leaves a Doc is only
//   - the title line, heading texts, first-column labels of 2-column tables and top-level agenda
//     labels, each cut to 80 characters;
//   - the text before ":" of a line when it is at most 3 words (roles such as "Kassör");
//   - counts.
// Never body text, sub-bullet text or table cell values. Pure: no Google client.

export interface DocStructure {
  title: string | null;
  headings: { level: number; text: string }[];
  tableLabels: string[];
  topItems: string[];
  /** Per top item: how many non-empty lines it holds (counts only, never their text). */
  nestedCounts: number[];
  numbering: "numbered" | "paragraph" | "none";
  linePrefixes: { prefix: string; count: number }[];
  /** Lines under the tasks heading: how many, how many carry a date, how many an owner prefix. */
  taskLines: { total: number; withDate: number; withOwner: number };
}

const MAX = 80;
const MAX_HEADINGS = 40;
const MAX_TABLE_LABELS = 12;
const MAX_ITEMS = 30;
const MAX_PREFIXES = 20;

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const cut = (s: string) => collapse(s).slice(0, MAX).trim();
const words = (s: string) => collapse(s).split(" ").filter(Boolean);

/** Two or more words that all start with a capital: likely a person's name ("Elin Berglund"). */
const looksLikeName = (s: string) => {
  const w = words(s);
  return w.length >= 2 && w.every((x) => /^\p{Lu}/u.test(x));
};

/** Letters, spaces, hyphens, "&" and "/" only: no digits (dates, times), no URLs, no symbols. */
const LABELISH = /^\p{L}[\p{L} &/-]*$/u;

/** The text before the first ":" when it is a short label (1–3 words), else null. */
export function linePrefix(line: string): string | null {
  const i = line.indexOf(":");
  if (i <= 0 || line[i + 1] === "/") return null;
  const prefix = collapse(line.slice(0, i));
  if (!prefix || prefix.length > MAX || !LABELISH.test(prefix)) return null;
  const n = words(prefix).length;
  if (n < 1 || n > 3 || looksLikeName(prefix)) return null;
  return prefix;
}

/** A date or weekday in a task line: 2026-11-25, 25/11, 25.11, 25 nov, "fre", "v. 48". */
const DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}\b|\b\d{1,2}\s*(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\p{L}*|\b(?:mån|tis|ons|tors|tor|fre|lör|sön)(?:dag)?\b|\bv(?:ecka|\.)?\s?\d{1,2}\b/iu;

/** Union of the standard profiles' labels, so every standard shape scans (never returned). */
const SCAN_PROFILE: FormatProfile = {
  ...VECKOMOTE,
  infoTable: [...new Set([...(VECKOMOTE.infoTable ?? []), ...(STYRELSEPROTOKOLL.infoTable ?? [])])],
  fixedAgendaItems: [
    ...VECKOMOTE.fixedAgendaItems,
    ...STYRELSEPROTOKOLL.fixedAgendaItems.filter((s) => !VECKOMOTE.fixedAgendaItems.some((v) => v.label === s.label)),
  ],
};

/** A typed item number at the start of a line: "§1 ", "§ 2. ", "3. ", "4) ". */
const TYPED = /^(?:§\s*\d+[.)]?|\d+[.)])\s+/;
const isHeadingOnlyNumber = (line: string) => line.replace(TYPED, "").trim() === "";

const isHeading = (p: Paragraph) => /^(HEADING_[1-6]|TITLE|SUBTITLE)$/.test(paraStyle(p));
const headingLevel = (p: Paragraph) => {
  const s = paraStyle(p);
  return s === "TITLE" ? 0 : s === "SUBTITLE" ? 1 : Number(s.slice(-1));
};

function firstTabId(doc: docs_v1.Schema$Document): string | null {
  return doc.tabs?.[0]?.tabProperties?.tabId ?? null;
}

export function docStructure(doc: docs_v1.Schema$Document): DocStructure {
  const empty: DocStructure = {
    title: null,
    headings: [],
    tableLabels: [],
    topItems: [],
    nestedCounts: [],
    numbering: "none",
    linePrefixes: [],
    taskLines: { total: 0, withDate: 0, withOwner: 0 },
  };
  const tabId = firstTabId(doc);
  if (!tabId) return empty;
  const tab = parseNotesTab(doc, tabId);
  const body = tab.paragraphs.filter((p) => !paraInTable(p) && paraLine(p).trim() !== "");
  const scan = scanAgenda(tab, SCAN_PROFILE);

  // Title: the scanned title line, only when it is short like a title (else it may be prose).
  const titleText = scan.title ? collapse(scan.title.text).replace(/:\s*$/, "") : "";
  const title = titleText && words(titleText).length <= 8 ? cut(titleText) : null;

  const headings = body
    .filter(isHeading)
    .slice(0, MAX_HEADINGS)
    .map((p) => ({ level: headingLevel(p), text: cut(paraLine(p)) }));

  // First-column labels of 2-column tables (label | value), short and not a person's name.
  const tableLabels: string[] = [];
  for (const table of tab.tables ?? []) {
    if (!table.rows.length || !table.rows.every((r) => r.cells.length === 2)) continue;
    for (const row of table.rows) {
      const label = collapse(row.cells[0].text).replace(/[\s:]+$/, "");
      if (!label || words(label).length > 4 || looksLikeName(label) || /\d/.test(label)) continue;
      const text = cut(label);
      if (!tableLabels.includes(text) && tableLabels.length < MAX_TABLE_LABELS) tableLabels.push(text);
    }
  }

  let items: { label: string; paraStart: number; lines: number }[] = scan.items.map((i) => ({
    label: i.label,
    paraStart: i.paraStart,
    lines: i.humanText ? i.humanText.split("\n").filter((l) => l.trim()).length : 0,
  }));
  // No agenda heading and no list (common in a styrelseprotokoll): the scan finds no region, so
  // short typed "§1 …" / "1. …" lines are the items.
  if (items.length === 0) {
    for (const p of body) {
      const line = collapse(paraLine(p));
      if (TYPED.test(line) && !isHeadingOnlyNumber(line) && words(line).length <= 8) {
        items.push({ label: line.replace(TYPED, "").trim(), paraStart: p.start, lines: 0 });
      } else if (items.length && !isHeading(p)) items[items.length - 1].lines++;
    }
  }
  items = items.slice(0, MAX_ITEMS);
  const topItems = items.map((i) => cut(i.label));
  const nestedCounts = items.map((i) => i.lines);

  // Numbering by majority over the items: a numbered list glyph or a typed "1." → numbered,
  // a typed "§1" → paragraph.
  const byStart = new Map(tab.paragraphs.map((p) => [p.start, p] as const));
  let numbered = 0;
  let paragraph = 0;
  for (const item of items) {
    const p = byStart.get(item.paraStart);
    if (!p) continue;
    const raw = collapse(paraLine(p));
    const b = paraBullet(p);
    if (/^§\s*\d+/.test(raw)) paragraph++;
    else if (/^\d+[.)]\s/.test(raw) || (b && isNumberedGlyph(listGlyph(tab, b.listId, b.level)))) numbered++;
  }
  const numbering = paragraph === 0 && numbered === 0 ? "none" : paragraph > numbered ? "paragraph" : "numbered";

  const prefixCounts = new Map<string, number>();
  for (const p of body) {
    const prefix = linePrefix(paraLine(p));
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const linePrefixes = [...prefixCounts]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || (a.prefix < b.prefix ? -1 : 1))
    .slice(0, MAX_PREFIXES);

  // Task lines: non-heading body lines after the tasks heading, up to the notes heading.
  const taskLines = { total: 0, withDate: 0, withOwner: 0 };
  if (scan.tasksHeading) {
    const from = scan.tasksHeading.end;
    const to = scan.notesHeading && scan.notesHeading.start > from ? scan.notesHeading.start : Infinity;
    for (const p of body) {
      if (p.start < from || p.start >= to || isHeading(p)) continue;
      const line = paraLine(p);
      taskLines.total++;
      if (DATE.test(line)) taskLines.withDate++;
      if (linePrefix(line)) taskLines.withOwner++;
    }
  }

  return { title, headings, tableLabels, topItems, nestedCounts, numbering, linePrefixes, taskLines };
}
