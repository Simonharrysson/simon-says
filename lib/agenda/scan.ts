import type { FormatProfile } from "@/lib/formats/schema";
import { isNumberedGlyph, listGlyph, paraBullet, paraInTable, paraLine, paraStyle, type NotesTab, type Paragraph } from "@/lib/docs/tab";

// Scanning a human's agenda Doc (spec "Builder check — answers" 2): title line, a 2-column info
// table, an agenda heading, the agenda items (top-level list items or headings), then the tasks
// and notes headings. Read-only: the scan never writes. Table-cell paragraphs are skipped by
// every rule here (cells are read from `tab.tables`).
//
// Keys `ag-<n>` number the items in Doc order at scan time, so they shift when a human inserts
// or deletes an item (pre-flight F4). Keys are only for anchoring; afterwards an anchor is found
// through its named range (`itemSpan`) and mapped back to the scanned item with `itemAt`.

export interface AgendaItem {
  /** `ag-<n>`, 1-based in Doc order. */
  key: string;
  /** The paragraph text, a typed leading number ("4. ", "§4 ") dropped, spaces collapsed. */
  label: string;
  kind: "list" | "heading";
  /** The item's own paragraph, newline included (same convention as `ItemSpan.paraStart/paraEnd`). */
  paraStart: number;
  paraEnd: number;
  /** List nesting level of the item; 0 for heading items. */
  level: number;
  /** End of the last non-empty paragraph belonging to the item (its own paragraph at least). */
  blockEnd: number;
  /** Where the item's (last) block stops: the next item's paraStart, or the end of the agenda region. */
  blockLimit: number;
  /**
   * Every part of the Doc that belongs to the item, `[start, limit)` in Doc order: its own block,
   * then the block under each later heading that repeats its label (R-A5 rule 2).
   */
  blocks: { start: number; limit: number }[];
  /** The blocks' non-empty paragraphs after the item line (repeated headings left out), one per line. */
  humanText: string;
}

export interface InfoCell {
  /** The profile's spelling when the label matches one, else the label cell's text without ":". */
  field: string;
  labelCell: { start: number; end: number };
  valueCell: { paragraphStart: number; empty: boolean; text: string };
}

export interface AgendaScan {
  title: { start: number; end: number; text: string } | null;
  info: InfoCell[];
  agendaHeading: { start: number; end: number } | null;
  items: AgendaItem[];
  tasksHeading: { start: number; end: number; text: string } | null;
  notesHeading: { start: number; end: number; text: string } | null;
}

const AGENDA_LABELS = ["agenda", "dagordning"];
const TASKS_LABELS = ["vad ska vi göra till nästa gång", "att göra", "till nästa gång", "uppgifter"];
const NOTES_LABELS = ["anteckningar", "övriga anteckningar", "noteringar"];
const DEFAULT_INFO = ["Datum", "Tid", "Närvarande"];
/** Fixed items known whatever the profile says (Ruling R-A5 rule 4). */
const DEFAULT_FIXED = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Övrigt"];

/** A typed item number: "4. ", "4) ", "§4 ", "§ 4. ". Bare digits ("17 maj-fest") are kept. */
const LEADING_NUMBER = /^\s*(?:§\s*\d+[.)]?|\d+[.)])\s*/;
/** The typed-number rule (pre-flight F11): a plain paragraph like "1. Godkänn dagordning". */
const TYPED_ITEM = /^\d+\.\s/;

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** Lowercase, NFC, leading "§1."/"1." numbers and trailing ":"/"?" stripped, spaces collapsed. */
export function normLabel(s: string): string {
  return collapse(s).toLowerCase().replace(LEADING_NUMBER, "").replace(/[\s:?]+$/, "").trim();
}

/** Label for display: typed leading number dropped, spaces collapsed. */
const itemLabel = (s: string) => collapse(s).replace(LEADING_NUMBER, "").trim();

const isEmpty = (p: Paragraph) => paraLine(p).trim() === "";
const isHeadingStyle = (p: Paragraph) => paraStyle(p).startsWith("HEADING_");

/** The item one of whose blocks contains `index`, or null. */
export function itemAt(scan: AgendaScan, index: number): AgendaItem | null {
  return scan.items.find((i) => i.blocks.some((b) => index >= b.start && index < b.limit)) ?? null;
}

export function scanAgenda(tab: NotesTab, profile: FormatProfile): AgendaScan {
  const paras = tab.paragraphs.filter((p) => !paraInTable(p));
  const set = (base: string[], extra: (string | null | undefined)[]) =>
    new Set([...base, ...extra.filter((x): x is string => Boolean(x)).map(normLabel)].filter(Boolean));
  const agendaLabels = set(AGENDA_LABELS, [profile.agendaHeading]);
  const tasksLabels = set(TASKS_LABELS, [profile.tasksSection?.label]);
  const notesLabels = set(NOTES_LABELS, [profile.notesSection?.label]);
  const fixedLabels = set(DEFAULT_FIXED.map(normLabel), profile.fixedAgendaItems.map((i) => i.label));
  const isAgendaLabel = (p: Paragraph) => agendaLabels.has(normLabel(paraLine(p)));
  const sectionHeading = (p: Paragraph, labels: Set<string>) =>
    !paraBullet(p) && !isEmpty(p) && labels.has(normLabel(paraLine(p)));

  // Info table: the first table whose first column carries ≥ 2 known field labels.
  const fields = [...(profile.infoTable ?? []), ...DEFAULT_INFO];
  const fieldOf = new Map(fields.map((f) => [normLabel(f), f] as const));
  let info: InfoCell[] = [];
  let infoTable: { start: number; end: number } | null = null;
  for (const table of tab.tables ?? []) {
    const rows = table.rows.filter((r) => r.cells.length >= 2);
    if (rows.filter((r) => fieldOf.has(normLabel(r.cells[0].text))).length < 2) continue;
    infoTable = table;
    info = rows.map((r) => {
      const [label, value] = r.cells;
      return {
        field: fieldOf.get(normLabel(label.text)) ?? collapse(label.text).replace(/[\s:]+$/, ""),
        labelCell: { start: label.start, end: label.end },
        valueCell: { paragraphStart: value.paragraphStart, empty: value.text.trim() === "", text: value.text },
      };
    });
    break;
  }

  // Agenda region: after the agenda heading, else from the first list after the info table.
  const agendaIdx = paras.findIndex((p) => sectionHeading(p, agendaLabels));
  let regionStart = -1;
  if (agendaIdx >= 0) regionStart = agendaIdx + 1;
  else {
    const after = infoTable?.end ?? 0;
    regionStart = paras.findIndex((p) => p.start >= after && paraBullet(p) && !isEmpty(p));
  }
  const searchFrom = regionStart >= 0 ? regionStart : 0;
  const tasksIdx = paras.findIndex((p, i) => i >= searchFrom && sectionHeading(p, tasksLabels));
  const notesIdx = paras.findIndex((p, i) => i >= searchFrom && sectionHeading(p, notesLabels));
  const regionEnd = Math.min(...[tasksIdx, notesIdx, paras.length].filter((i) => i >= 0));

  const items: AgendaItem[] = [];
  if (regionStart >= 0 && regionStart < regionEnd) {
    const region = paras.slice(regionStart, regionEnd);
    const limit = regionEnd < paras.length ? paras[regionEnd].start : (paras[paras.length - 1]?.end ?? 0);
    // Ruling R-A5. Never an item: an empty paragraph or one labelled like the agenda heading (5).
    const candidate = (p: Paragraph) => !isEmpty(p) && !isAgendaLabel(p);
    const listParas = region.filter((p) => candidate(p) && paraBullet(p));
    const hasHeadings = region.some((p) => candidate(p) && !paraBullet(p) && isHeadingStyle(p));
    // (1) Fully bold or typed-number plain lines mark items only in a Doc without list or heading
    // items; elsewhere they are a human's notes under the item.
    const boldOnly = listParas.length === 0 && !hasHeadings;
    const nonListItem = (p: Paragraph) => {
      if (!candidate(p) || paraBullet(p)) return false;
      const line = paraLine(p);
      if (isHeadingStyle(p) || fixedLabels.has(normLabel(line))) return true; // (4) "<fixed label>:"
      return boldOnly && (Boolean(p.bold) || TYPED_ITEM.test(collapse(line)));
    };
    // (3) Lists first seen before the first non-list item hold items at their lowest level. The
    // glyph rule, for a list first seen after it: items only when it starts at level 0 and its
    // level-0 glyph type is known to be numbered (a restarted numbered list). Bulleted OR unknown
    // (list missing from the tab, or a level with neither glyphType nor glyphSymbol) → sub-points
    // of the preceding item: a false sub-point only merges two items, a false item splits a block.
    const firstNonList = region.findIndex(nonListItem);
    const boundary = firstNonList >= 0 ? region[firstNonList].start : Infinity;
    const lists = new Map<string, { first: number; minLevel: number }>();
    for (const p of listParas) {
      const b = paraBullet(p)!;
      const l = lists.get(b.listId);
      if (!l) lists.set(b.listId, { first: p.start, minLevel: b.level });
      else l.minLevel = Math.min(l.minLevel, b.level);
    }
    const early = [...lists.values()].filter((l) => l.first < boundary);
    const earlyMin = early.length ? Math.min(...early.map((l) => l.minLevel)) : 0;
    const isListItem = (p: Paragraph) => {
      const b = paraBullet(p)!;
      const l = lists.get(b.listId)!;
      if (l.first < boundary) return b.level === earlyMin;
      const glyph = listGlyph(tab, b.listId, 0);
      return l.minLevel === 0 && b.level === 0 && isNumberedGlyph(glyph);
    };
    const isItem = (p: Paragraph) => candidate(p) && (paraBullet(p) ? isListItem(p) : nonListItem(p));

    type Rec = { item: AgendaItem; lines: string[] };
    const recs: Rec[] = [];
    let current: Rec | null = null;
    const close = (next: number) => {
      if (current) current.item.blocks[current.item.blocks.length - 1].limit = next;
    };
    for (const p of region) {
      if (isItem(p)) {
        close(p.start);
        let label = itemLabel(paraLine(p));
        // A plain "<fixed label>:" item is labelled exactly as the profile's fixed item.
        if (!paraBullet(p) && fixedLabels.has(normLabel(label))) label = label.replace(/:\s*$/, "");
        // (2) A heading repeating an earlier item's label continues that item.
        const earlier = paraBullet(p) ? undefined : recs.find((r) => normLabel(r.item.label) === normLabel(label));
        if (earlier) {
          earlier.item.blocks.push({ start: p.start, limit: p.end });
          earlier.item.blockEnd = p.end;
          current = earlier;
          continue;
        }
        const b = paraBullet(p);
        current = {
          item: {
            key: `ag-${recs.length + 1}`,
            label,
            kind: b ? "list" : "heading",
            paraStart: p.start,
            paraEnd: p.end,
            level: b?.level ?? 0,
            blockEnd: p.end,
            blockLimit: p.end,
            blocks: [{ start: p.start, limit: p.end }],
            humanText: "",
          },
          lines: [],
        };
        recs.push(current);
      } else if (current && !isEmpty(p)) {
        current.lines.push(collapse(paraLine(p)));
        current.item.blockEnd = p.end;
      }
    }
    close(limit);
    for (const r of recs) {
      r.item.blockLimit = r.item.blocks[r.item.blocks.length - 1].limit;
      r.item.humanText = r.lines.join("\n");
      items.push(r.item);
    }
  }

  // Title: the first non-empty body paragraph, if it comes before the info table, the agenda
  // heading and the first item, and is no section heading itself.
  let title: AgendaScan["title"] = null;
  const first = paras.find((p) => !isEmpty(p));
  if (first) {
    const before = Math.min(infoTable?.start ?? Infinity, agendaIdx >= 0 ? paras[agendaIdx].start : Infinity, items[0]?.paraStart ?? Infinity);
    const isSection = [agendaLabels, tasksLabels, notesLabels].some((l) => sectionHeading(first, l));
    if (first.start < before && !isSection && !paraBullet(first)) {
      title = { start: first.start, end: first.end, text: collapse(paraLine(first)) };
    }
  }

  const heading = (i: number) =>
    i >= 0 ? { start: paras[i].start, end: paras[i].end, text: collapse(paraLine(paras[i])) } : null;
  return {
    title,
    info,
    agendaHeading: agendaIdx >= 0 ? { start: paras[agendaIdx].start, end: paras[agendaIdx].end } : null,
    items,
    tasksHeading: heading(tasksIdx),
    notesHeading: heading(notesIdx),
  };
}
