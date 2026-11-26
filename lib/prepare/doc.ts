import { scanAgenda, withoutEarlierLines, type AgendaScan } from "@/lib/agenda/scan";
import type { ItemRole, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { planFormatRender } from "@/lib/docs/format-render";
import { currentItems, diffHumanEdits, itemSpan, ownedSpan, renderedRows, toNotesItem, type RenderPlan } from "@/lib/docs/notes";
import { paraInTable, type NotesTab, type Paragraph } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { replaceRange, type DocsRequest } from "@/lib/google/docs";
import type { DraftItem } from "./draft";

// The prepared agenda Doc, planned from a read of its tab (pure, so the Docs simulator tests it).
// Simon Says owns exactly the lines it wrote, each under a named range:
// - agenda items: `ss-prep-<id>-ag-<n>` (a structure range: the start-time scan keeps the
//   paragraph as an item, lib/agenda/scan STRUCTURE_RANGE);
// - "Från förra veckan" lines: `ss-prep-<id>-c<n>`, rendered by the notes engine itself
//   (planFormatRender with a stand-in meeting `prep-<id>`), so the meeting started in the Doc can
//   adopt them as its own carried rows (carryPlan's `sameDoc`) and later write "✓ klart" there.
// Preparing again follows the notes engine's rule: a line still exactly as we wrote it is ours
// (changed, moved or removed); a line a human edited or deleted is theirs and is never touched.

/** One agenda item line Simon Says wrote: the draft item, its anchor key, range and exact text. */
export interface DocLine {
  id: string;
  key: string;
  range: string;
  text: string;
}

/** The stand-in meeting id of a prepared agenda (range names `ss-prep-<id>-…`). */
export const prepKey = (preparedId: string) => `prep-${preparedId}`;
const itemRange = (key: string, n: number) => `ss-${key}-ag-${n}`;

/** An item's line in the Doc: "§3 Val av justerare" in a § format, else the label. */
export function itemText(profile: FormatProfile, label: string, position: number): string {
  return profile.numbering === "paragraph" ? `§${position} ${label}` : label;
}

/**
 * The stand-in meeting the notes engine renders the carried lines for: the item lines as its
 * anchors, their draft roles as its agenda roles. No header, no tasks or notes anchors.
 */
export function prepMeeting(key: string, docId: string, tabId: string, lines: DocLine[], items: DraftItem[]): MeetingRow {
  const roles = new Map(items.map((i) => [i.id, i.role]));
  return {
    id: key,
    org_id: "",
    doc_id: docId,
    notes_tab_id: tabId,
    header_range: null,
    header_rendered: null,
    section_ranges: Object.fromEntries(lines.map((l) => [l.key, l.range])),
    agenda_roles: Object.fromEntries(lines.map((l) => [l.key, (roles.get(l.id) ?? "topic") as ItemRole])),
    layout: "format",
  } as unknown as MeetingRow;
}

/** The anchor key of the follow-up item's line, if it is still in the Doc. */
export function followupKey(tab: NotesTab, lines: DocLine[], items: DraftItem[]): string | null {
  const id = items.find((i) => i.role === "followup" && i.on)?.id;
  const line = id ? lines.find((l) => l.id === id) : undefined;
  return line && itemSpan(tab, line.range) ? line.key : null;
}

const scanOf = (tab: NotesTab, profile: FormatProfile) => scanAgenda(withoutEarlierLines(tab), profile);
const nextN = (lines: DocLine[]) => Math.max(0, ...lines.map((l) => Number(l.key.slice(3)) || 0)) + 1;

/**
 * A Doc just written from the skeleton (createFormatDoc): a range over each item line, in order.
 * Throws when the scan does not find exactly the items written (nothing is written then).
 */
export function planItemRanges(tab: NotesTab, profile: FormatProfile, key: string, items: DraftItem[]): { requests: DocsRequest[]; lines: DocLine[] } {
  const on = items.filter((i) => i.on);
  const scan = scanOf(tab, profile);
  if (scan.items.length !== on.length) throw new Error(`prepare: ${scan.items.length} items in the new Doc, ${on.length} written`);
  const lines: DocLine[] = [];
  const requests: DocsRequest[] = scan.items.map((s, i) => {
    const range = itemRange(key, i + 1);
    const p = tab.paragraphs.find((x) => x.start === s.paraStart)!;
    lines.push({ id: on[i].id, key: `ag-${i + 1}`, range, text: p.text.replace(/\n$/, "") });
    return { createNamedRange: { name: range, range: { tabId: tab.tabId, startIndex: s.paraStart, endIndex: s.paraEnd - 1 } } };
  });
  return { requests, lines };
}

/** A stored item line exactly as we wrote it (ours), edited by a human, or gone. */
function lineState(tab: NotesTab, line: DocLine): { state: "owned" | "edited" | "gone"; para: Paragraph | null } {
  const span = itemSpan(tab, line.range);
  if (!span) return { state: "gone", para: null };
  const para = tab.paragraphs.find((p) => p.start === span.paraStart) ?? null;
  const owned = !span.ambiguous && !span.suggested && span.rangeText === span.paraText && span.paraText === line.text;
  return { state: owned ? "owned" : "edited", para };
}

/** Where the agenda's items live: after the agenda heading, up to the tasks (or notes) heading. */
function region(scan: AgendaScan): { start: number; limit: number } | null {
  const limit = scan.tasksHeading?.start ?? scan.notesHeading?.start ?? null;
  if (!scan.agendaHeading || limit === null || limit <= scan.agendaHeading.end) return null;
  return { start: scan.agendaHeading.end, limit };
}

export type ReprepareMode = "rewrite" | "merge";

/**
 * Preparing again, step 1 (items). From a fresh read:
 * - "rewrite" when nobody touched the agenda in the Doc (every non-empty paragraph between the
 *   agenda heading and the tasks heading is one of our lines, as we wrote it): the region is
 *   replaced by the new list in the new order, with fresh ranges;
 * - "merge" otherwise: our untouched lines that left the draft are deleted, the ones whose text
 *   changed are replaced; a human's edited line and a line a human deleted stay as they are (the
 *   draft's item is not written again); new items are inserted afterwards, one per step
 *   (`planInsert`), so the order of the Doc around human text is kept.
 * `carried`: the stored carried rows (their untouched lines count as ours).
 */
export function planReprepare(
  tab: NotesTab,
  profile: FormatProfile,
  key: string,
  stored: DocLine[],
  carried: NoteItemRow[],
  items: DraftItem[],
): { mode: ReprepareMode; requests: DocsRequest[]; lines: DocLine[]; inserts: string[] } {
  const on = items.filter((i) => i.on);
  const scan = scanAgenda(tab, profile);
  const reg = region(scan);
  const states = new Map(stored.map((l) => [l.id, lineState(tab, l)]));
  const ourSpans = [
    ...stored.flatMap((l) => (states.get(l.id)!.state === "owned" ? [states.get(l.id)!.para!] : [])),
    ...carried.flatMap((r) => {
      const s = ownedSpan(tab, r);
      return s ? tab.paragraphs.filter((p) => p.start >= s.paraStart && p.start < s.paraEnd) : [];
    }),
  ].map((p) => p.start);
  const regionParas = reg ? tab.paragraphs.filter((p) => !paraInTable(p) && p.start >= reg.start && p.start < reg.limit) : [];
  const pure = reg !== null && regionParas.every((p) => p.text.trim() === "" || ourSpans.includes(p.start));

  if (pure && reg) {
    const numbered = profile.numbering === "numbered";
    const texts = on.map((i, n) => itemText(profile, i.label, n + 1));
    const requests: DocsRequest[] = [];
    // Our ranges go first (named ranges change no text; only names present are deleted).
    for (const name of new Set([...stored.map((l) => l.range), ...carried.map((r) => r.range_name).filter((x): x is string => Boolean(x))])) {
      if (tab.ranges.has(name)) requests.push({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tab.tabId] } } });
    }
    requests.push({ deleteContentRange: { range: { tabId: tab.tabId, startIndex: reg.start, endIndex: reg.limit } } });
    // At reg.start now stands the tasks heading: the new paragraphs take its style, set below.
    requests.push({ insertText: { text: texts.map((t) => `${t}\n`).join(""), location: { tabId: tab.tabId, index: reg.start } } });
    const lines: DocLine[] = [];
    let at = reg.start;
    texts.forEach((text, n) => {
      const end = at + text.length;
      requests.push({
        updateParagraphStyle: {
          range: { tabId: tab.tabId, startIndex: at, endIndex: end },
          paragraphStyle: { namedStyleType: numbered ? "NORMAL_TEXT" : "HEADING_3" },
          fields: "namedStyleType",
        },
      });
      const range = itemRange(key, n + 1);
      requests.push({ createNamedRange: { name: range, range: { tabId: tab.tabId, startIndex: at, endIndex: end } } });
      lines.push({ id: on[n].id, key: `ag-${n + 1}`, range, text });
      at = end + 1;
    });
    // No tabs in these lines: the bullets shift nothing.
    if (numbered && texts.length) {
      requests.push({
        createParagraphBullets: { range: { tabId: tab.tabId, startIndex: reg.start, endIndex: at - 1 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" },
      });
    }
    return { mode: "rewrite", requests, lines, inserts: [] };
  }

  // Merge: one batch of deletes and replaces (highest index first), inserts afterwards.
  const want = new Map(on.map((i, n) => [i.id, itemText(profile, i.label, n + 1)]));
  const ops: { index: number; requests: DocsRequest[] }[] = [];
  const lines: DocLine[] = [];
  for (const line of stored) {
    const { state, para } = states.get(line.id)!;
    if (state === "gone") continue;
    const text = want.get(line.id);
    if (state === "edited") {
      // A human's line now: kept, and still the item's anchor while its range lives.
      lines.push(line);
      continue;
    }
    if (text === undefined) {
      ops.push({
        index: para!.start,
        requests: [
          { deleteNamedRange: { name: line.range, tabsCriteria: { tabIds: [tab.tabId] } } },
          { deleteContentRange: { range: { tabId: tab.tabId, startIndex: para!.start, endIndex: para!.end } } },
        ],
      });
      continue;
    }
    if (text !== line.text) ops.push({ index: para!.start, requests: [replaceRange(tab.tabId, line.range, text)] });
    lines.push({ ...line, text });
  }
  ops.sort((a, b) => b.index - a.index);
  const known = new Set(stored.map((l) => l.id));
  return { mode: "merge", requests: ops.flatMap((o) => o.requests), lines, inserts: on.filter((i) => !known.has(i.id)).map((i) => i.id) };
}

/**
 * Merge, one new item: inserted before the next item of the draft that is still in the Doc (it
 * takes that line's list and level), else after the previous one; null when no line of the
 * draft is left to place it by. Its range covers the new text.
 */
export function planInsert(
  tab: NotesTab,
  profile: FormatProfile,
  key: string,
  lines: DocLine[],
  items: DraftItem[],
  id: string,
): { requests: DocsRequest[]; line: DocLine } | null {
  const on = items.filter((i) => i.on);
  const pos = on.findIndex((i) => i.id === id);
  if (pos < 0) return null;
  const text = itemText(profile, on[pos].label, pos + 1);
  const present = (i: DraftItem) => {
    const l = lines.find((x) => x.id === i.id);
    const span = l ? itemSpan(tab, l.range) : null;
    return span ? tab.paragraphs.find((p) => p.start === span.paraStart) ?? null : null;
  };
  const range = itemRange(key, nextN(lines));
  const lineOf = (start: number) => ({ id, key: `ag-${nextN(lines)}`, range, text, start });
  const next = on.slice(pos + 1).map(present).find((p): p is Paragraph => p !== null);
  let start: number;
  const requests: DocsRequest[] = [];
  if (next) {
    start = next.start;
    requests.push({ insertText: { text: `${text}\n`, location: { tabId: tab.tabId, index: start } } });
  } else {
    const prev = on.slice(0, pos).reverse().map(present).find((p): p is Paragraph => p !== null);
    if (!prev) return null;
    start = prev.end;
    requests.push({ insertText: { text: `\n${text}`, location: { tabId: tab.tabId, index: prev.end - 1 } } });
  }
  requests.push({ createNamedRange: { name: range, range: { tabId: tab.tabId, startIndex: start, endIndex: start + text.length } } });
  const { start: _s, ...line } = lineOf(start);
  return { requests, line };
}

/**
 * The carried lines, step 2 (a fresh read): the stored rows with human edits applied (an edited
 * line is locked, a deleted one stays deleted), rendered towards `desired` by the notes engine
 * under the follow-up item. Rows whose line was removed with the region (rewrite) count as
 * never rendered. Returns the plan and the rows to store (deleted ones kept, so the start never
 * carries those tasks again).
 */
export function planCarried(
  tab: NotesTab,
  meeting: MeetingRow,
  stored: NoteItemRow[],
  desired: NoteItemRow[],
  opts: { profile: FormatProfile; ownerLabel: (owner: string) => string; rewritten: boolean },
): { plan: RenderPlan; rows: NoteItemRow[] } {
  const src = (r: NoteItemRow) => `${r.carried_from_meeting}\u0000${r.carried_from_id}`;
  const base = opts.rewritten
    ? stored.filter((r) => r.deleted_by_human).map((r) => ({ ...r, range_name: null }))
    : diffHumanEdits(stored, currentItems(tab, stored)).rows;
  const bySource = new Map(base.map((r) => [src(r), r]));
  let n = Math.max(0, ...stored.map((r) => Number(r.id.slice(1)) || 0));
  const fresh: NoteItemRow[] = [];
  const items = desired.flatMap((r) => {
    const old = bySource.get(src(r));
    // A task a human deleted from the Doc is never written again; an edited line is theirs.
    if (old?.deleted_by_human || old?.locked) return [];
    if (old) return [toNotesItem({ ...old, text: r.text, owner: r.owner, due: r.due, anchor: r.anchor })];
    const row = { ...r, id: `c${++n}`, meeting_id: meeting.id, range_name: null, last_rendered_text: null, position: 0 };
    fresh.push(row);
    return [toNotesItem(row)];
  });
  const rows = [...base, ...fresh];
  const plan = planFormatRender(meeting, tab, rows, items, { profile: opts.profile, ownerLabel: opts.ownerLabel });
  const out = renderedRows(meeting.id, rows, items, plan).map((r) => {
    const want = desired.find((d) => src(d) === src(r));
    return want ? { ...r, owner_person_id: want.owner_person_id } : r;
  });
  return { plan, rows: out };
}
