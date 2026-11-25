import type { FormatProfile } from "@/lib/formats/schema";
import { paraBullet, paraInTable, paraLine, paraStyle, type NotesTab, type Paragraph } from "@/lib/docs/tab";

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
  /** Where the item's block stops: the next item's paraStart, or the end of the agenda region. */
  blockLimit: number;
  /** The block's non-empty paragraphs after the item line, one per line. */
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

/** The item that contains `index`: its block runs from its paraStart up to its blockLimit. */
export function itemAt(scan: AgendaScan, index: number): AgendaItem | null {
  return scan.items.find((i) => index >= i.paraStart && index < i.blockLimit) ?? null;
}

export function scanAgenda(tab: NotesTab, profile: FormatProfile): AgendaScan {
  const paras = tab.paragraphs.filter((p) => !paraInTable(p));
  const set = (base: string[], extra: (string | null | undefined)[]) =>
    new Set([...base, ...extra.filter((x): x is string => Boolean(x)).map(normLabel)].filter(Boolean));
  const agendaLabels = set(AGENDA_LABELS, [profile.agendaHeading]);
  const tasksLabels = set(TASKS_LABELS, [profile.tasksSection?.label]);
  const notesLabels = set(NOTES_LABELS, [profile.notesSection?.label]);
  const fixedLabels = set([], profile.fixedAgendaItems.map((i) => i.label));
  const known = new Set([...agendaLabels, ...tasksLabels, ...notesLabels, ...fixedLabels]);

  /** HEADING_* style, fully bold, or a plain paragraph with a known label. Never a list item. */
  const headingLike = (p: Paragraph) =>
    !paraBullet(p) && !isEmpty(p) && (isHeadingStyle(p) || Boolean(p.bold) || known.has(normLabel(paraLine(p))));
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
    const nonListItem = (p: Paragraph) => headingLike(p) || (!paraBullet(p) && TYPED_ITEM.test(collapse(paraLine(p))));
    const levels = region.filter((p) => paraBullet(p) && !isEmpty(p)).map((p) => paraBullet(p)!.level);
    const minLevel = levels.length ? Math.min(...levels) : 0;
    // Lists that hold items: those with a top-level paragraph before the first heading item.
    // Bullets after a heading item, in a list not seen before it, are that item's sub-points.
    const firstHeading = region.findIndex(nonListItem);
    const itemLists = new Set(
      region
        .slice(0, firstHeading >= 0 ? firstHeading : region.length)
        .filter((p) => paraBullet(p) && !isEmpty(p) && paraBullet(p)!.level === minLevel)
        .map((p) => paraBullet(p)!.listId),
    );
    const isItem = (p: Paragraph) => {
      if (isEmpty(p)) return false;
      const b = paraBullet(p);
      if (b) return b.level === minLevel && itemLists.has(b.listId);
      return nonListItem(p);
    };

    let current: { item: AgendaItem; lines: string[] } | null = null;
    const close = (next: number) => {
      if (!current) return;
      current.item.blockLimit = next;
      current.item.humanText = current.lines.join("\n");
      items.push(current.item);
    };
    for (const p of region) {
      if (isItem(p)) {
        close(p.start);
        const b = paraBullet(p);
        current = {
          item: {
            key: `ag-${items.length + 1}`,
            label: itemLabel(paraLine(p)),
            kind: b ? "list" : "heading",
            paraStart: p.start,
            paraEnd: p.end,
            level: b?.level ?? 0,
            blockEnd: p.end,
            blockLimit: p.end,
            humanText: "",
          },
          lines: [],
        };
      } else if (current && !isEmpty(p)) {
        current.lines.push(collapse(paraLine(p)));
        current.item.blockEnd = p.end;
      }
    }
    close(limit);
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
