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

/**
 * Two agenda labels name the same item: equal after `normLabel`, or one holds the other as whole
 * words ("Val av justerare" ⊂ "Val av justerare och rösträknare"). No synonyms: "Val av
 * justerare" never matches "Val av mötesordförande".
 */
export function labelsMatch(a: string, b: string): boolean {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/** Label for display: typed leading number dropped, spaces collapsed. */
const itemLabel = (s: string) => collapse(s).replace(LEADING_NUMBER, "").trim();

const isEmpty = (p: Paragraph) => paraLine(p).trim() === "";
const isHeadingStyle = (p: Paragraph) => paraStyle(p).startsWith("HEADING_");

/**
 * How many agenda headings ("Agenda", "Dagordning", the profile's) the tab's body holds. A Doc
 * with several (one per week, final review R1 minor) is refused at the start: the scan would take
 * the first week's agenda.
 */
export function agendaHeadingCount(tab: NotesTab, profile: FormatProfile): number {
  const labels = new Set([...AGENDA_LABELS, ...(profile.agendaHeading ? [normLabel(profile.agendaHeading)] : [])]);
  return tab.paragraphs.filter((p) => !paraInTable(p) && !paraBullet(p) && !isEmpty(p) && labels.has(normLabel(paraLine(p)))).length;
}

/** The item one of whose blocks contains `index`, or null. */
export function itemAt(scan: AgendaScan, index: number): AgendaItem | null {
  return scan.items.find((i) => i.blocks.some((b) => index >= b.start && index < b.limit)) ?? null;
}

/**
 * Paragraph starts of a meeting's anchored agenda items: for each `ag-*` key of the anchor map
 * (and our `ss-<meeting>-ag-*` ranges the map lost, see adoptedAgendaRanges), the body paragraph
 * holding the start of its named range. Gone (empty) ranges are left out.
 */
export function anchoredStarts(tab: NotesTab, sectionRanges: Record<string, unknown>, meetingId?: string): number[] {
  const map = meetingId ? { ...adoptedAgendaRanges(tab, sectionRanges, meetingId), ...sectionRanges } : sectionRanges;
  const out = new Set<number>();
  for (const [key, name] of Object.entries(map)) {
    if (!/^ag-\d+$/.test(key) || typeof name !== "string") continue;
    const parts = (tab.ranges.get(name) ?? []).flat().filter((x) => x.end > x.start);
    if (!parts.length) continue;
    const at = Math.min(...parts.map((x) => x.start));
    const p = tab.paragraphs.find((x) => !paraInTable(x) && at >= x.start && at < x.end);
    if (p) out.add(p.start);
  }
  return [...out].sort((a, b) => a - b);
}

/** A range of ours that covers a human's text or a section of the Doc, never a line we wrote. */
const STRUCTURE_RANGE = /-(ag-\d+|sec-[a-z]+|header|live)$/;

/**
 * The tab without the paragraphs any of our item ranges touches (any meeting's `ss-*` range
 * except agenda anchors, section headings and the status line): for the scan at the start of a
 * meeting in a Doc an earlier meeting wrote in (final review R1-I1), so its lines (a "– " line,
 * a bullet list under a bold item) never decide which paragraphs are items. Indices unchanged.
 */
export function withoutEarlierLines(tab: NotesTab): NotesTab {
  const spans: { start: number; end: number }[] = [];
  for (const [name, entries] of tab.ranges) {
    if (!name.startsWith("ss-") || STRUCTURE_RANGE.test(name)) continue;
    for (const x of entries.flat()) if (x.end > x.start) spans.push(x);
  }
  if (!spans.length) return tab;
  const touched = (p: Paragraph) => !paraInTable(p) && spans.some((x) => x.start < p.end && x.end > p.start);
  return { ...tab, paragraphs: tab.paragraphs.filter((p) => !touched(p)) };
}

/**
 * Scan the agenda. `opts.anchors` (during a meeting: `anchoredStarts`) fixes the item mode to the
 * one found at the start (final review R1-I1), so a human's edit never unmakes the items:
 * - every anchored paragraph is an item, and the region reaches back to the first of them;
 * - the item mode comes from the anchored paragraphs: lists holding one keep items at that
 *   level, any other list follows the glyph rule (numbered at level 0 = items, else sub-points);
 *   bold / typed-number lines are items only when an anchored item is such a line (the
 *   bold-only rule (1) is no longer recomputed: one human bullet must not end it).
 * Without anchors: the start-time rules (R-A5) below.
 */
export function scanAgenda(tab: NotesTab, profile: FormatProfile, opts: { anchors?: number[] } = {}): AgendaScan {
  const paras = tab.paragraphs.filter((p) => !paraInTable(p));
  const anchored = opts.anchors ? new Set(opts.anchors) : null;
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
  if (anchored?.size) {
    const firstAnchor = paras.findIndex((p) => anchored.has(p.start));
    if (firstAnchor >= 0 && (regionStart < 0 || firstAnchor < regionStart)) regionStart = firstAnchor;
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
    const anchorParas = anchored ? region.filter((p) => anchored.has(p.start) && !isEmpty(p)) : [];
    // The mode fixed at the start: lists holding an anchored item (→ its level), and whether an
    // anchored item is a bold / typed-number line (not a heading, not a "<fixed label>:" line).
    const anchorLists = new Map<string, number>();
    for (const p of anchorParas) {
      const b = paraBullet(p);
      if (b && !anchorLists.has(b.listId)) anchorLists.set(b.listId, b.level);
    }
    const anchoredBold = anchorParas.some((p) => !paraBullet(p) && !isHeadingStyle(p) && !fixedLabels.has(normLabel(paraLine(p))));
    // (1) Fully bold or typed-number plain lines mark items only in a Doc without list or heading
    // items; elsewhere they are a human's notes under the item.
    const boldOnly = anchored ? anchoredBold : listParas.length === 0 && !hasHeadings;
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
    const lists = new Map<string, { first: number; last: number; minLevel: number }>();
    for (const p of listParas) {
      const b = paraBullet(p)!;
      const l = lists.get(b.listId);
      if (!l) lists.set(b.listId, { first: p.start, last: p.end, minLevel: b.level });
      else {
        l.minLevel = Math.min(l.minLevel, b.level);
        l.last = p.end;
      }
    }
    // A bulleted list that starts after an early numbered list's first item is that item's
    // sub-points, not items (final review R1-I1 probe at the start; glyph known as a bullet only).
    const numbered = [...lists].filter(([id, l]) => l.first < boundary && isNumberedGlyph(listGlyph(tab, id, l.minLevel)));
    const firstNumbered = Math.min(...numbered.map(([, l]) => l.first));
    // Parked N6: except a mixed agenda (items 1–3 numbered, 4–6 bulleted): a bulleted list at the
    // numbered items' level that starts right after the numbered list ends (it never resumes),
    // nothing but empty paragraphs between, holds items. Deeper, or under an item's own text → sub-points.
    const nothingBetween = (from: number, to: number) =>
      !region.some((p) => p.start >= from && p.start < to && !isEmpty(p)) && !(tab.tables ?? []).some((t) => t.start >= from && t.start < to);
    const continuesNumbered = (l: { first: number; minLevel: number }) =>
      numbered.some(([, a]) => a.minLevel === l.minLevel && a.last <= l.first && nothingBetween(a.last, l.first));
    const subLists = new Set(
      [...lists]
        .filter(([id, l]) => l.first < boundary && l.first > firstNumbered && listGlyph(tab, id, l.minLevel) === "BULLET" && !continuesNumbered(l))
        .map(([id]) => id),
    );
    const early = [...lists].filter(([id, l]) => l.first < boundary && !subLists.has(id)).map(([, l]) => l);
    const earlyMin = early.length ? Math.min(...early.map((l) => l.minLevel)) : 0;
    const isListItem = (p: Paragraph) => {
      const b = paraBullet(p)!;
      const l = lists.get(b.listId)!;
      if (anchored) {
        const level = anchorLists.get(b.listId);
        if (level !== undefined) return b.level === level;
        return l.minLevel === 0 && b.level === 0 && isNumberedGlyph(listGlyph(tab, b.listId, 0));
      }
      if (subLists.has(b.listId)) return false;
      if (l.first < boundary) return b.level === earlyMin;
      const glyph = listGlyph(tab, b.listId, 0);
      return l.minLevel === 0 && b.level === 0 && isNumberedGlyph(glyph);
    };
    const isItem = (p: Paragraph) =>
      (anchored?.has(p.start) && !isEmpty(p)) || (candidate(p) && (paraBullet(p) ? isListItem(p) : nonListItem(p)));

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
        // An anchored paragraph is its own item, whatever a human renamed it to.
        const earlier = paraBullet(p) || anchored?.has(p.start) ? undefined : recs.find((r) => normLabel(r.item.label) === normLabel(label));
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

/**
 * Agenda items a human added after the start (spec "Agenda items added during the meeting"):
 * scanned items whose own paragraph no `ag-*` range in `sectionRanges` touches. Their keys
 * continue after the highest existing `ag-<n>`, in Doc order; their role is `topic` (F5). The
 * range to create covers the item's text, newline left out, as at the start (anchor.ts).
 * Scan through `withoutOwnLines(tab, rows)` so our own lines are never taken for items.
 */
export function newAgendaItems(
  scan: AgendaScan,
  tab: NotesTab,
  sectionRanges: Record<string, unknown>,
  meetingId?: string,
): { key: string; start: number; end: number }[] {
  // Ranges of ours the map lost (see adoptedAgendaRanges) still count: never a second range.
  const map = meetingId ? { ...adoptedAgendaRanges(tab, sectionRanges, meetingId), ...sectionRanges } : sectionRanges;
  const keys = Object.keys(map).filter((k) => /^ag-\d+$/.test(k));
  const parts = keys
    .map((k) => map[k])
    .filter((name): name is string => typeof name === "string")
    .flatMap((name) => (tab.ranges.get(name) ?? []).flat())
    .filter((p) => p.end > p.start);
  let max = Math.max(0, ...keys.map((k) => Number(k.slice(3))));
  return scan.items
    .filter((i) => !parts.some((p) => p.start < i.paraEnd && p.end > i.paraStart))
    .map((i) => ({ key: `ag-${++max}`, start: i.paraStart, end: i.paraEnd - 1 }));
}

/**
 * This meeting's `ss-<meeting>-ag-<n>` ranges in the tab that the anchor map lacks (a render that
 * created them went through but storing the map did not): key → range name, to adopt into
 * `section_ranges` instead of creating a duplicate (an ambiguous range is never written through).
 * Only ranges with text, and only keys the map does not hold yet.
 */
export function adoptedAgendaRanges(tab: NotesTab, sectionRanges: Record<string, unknown>, meetingId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = `ss-${meetingId}-`;
  const mapped = new Set(Object.values(sectionRanges).filter((v): v is string => typeof v === "string"));
  for (const [name, entries] of tab.ranges) {
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (!/^ag-\d+$/.test(key) || key in sectionRanges || mapped.has(name)) continue;
    if (!entries.flat().some((p) => p.end > p.start)) continue;
    out[key] = name;
  }
  return out;
}

/**
 * The profile's required items (stadgar, Phase C) that no agenda item of the human's Doc names
 * (`labelsMatch`), in the profile's order and spelling. Only a warning at the start: Simon Says
 * never writes an item into a human's agenda.
 */
export function missingRequired(scan: AgendaScan, profile: FormatProfile): string[] {
  return profile.requiredItems.filter((req) => !scan.items.some((item) => labelsMatch(item.label, req)));
}
