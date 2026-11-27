import { itemAt, scanAgenda, withoutEarlierLines, type AgendaScan } from "@/lib/agenda/scan";
import type { ItemRole, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { planFormatRender } from "@/lib/docs/format-render";
import { currentItems, diffHumanEdits, itemSpan, ownedSpan, renderedRows, toNotesItem, type RenderPlan } from "@/lib/docs/notes";
import { OBJECT, paraInTable, paraStyle, type NotesTab, type Paragraph } from "@/lib/docs/tab";
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
/** An item line's range: `ss-<key>-ag-<n>` when created, `ss-<key>-g<gen>-ag-<n>` when prepared again (never a name used before). */
const itemRange = (key: string, n: number, gen = 0) => (gen ? `ss-${key}-g${gen}-ag-${n}` : `ss-${key}-ag-${n}`);

/**
 * Write-ahead journal of one Doc batch, saved before the batch is sent: every range the batch
 * writes, with the exact text we intend there (`id`: the draft item of a new item line), and
 * every range it deletes. The next run reconciles a batch that was written but never saved.
 */
export interface Journal {
  /** `row`: a new carried line's row, so an unsaved line is adopted (never written twice). */
  writes: { range: string; text: string; id?: string; row?: NoteItemRow }[];
  deletes: string[];
}

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
  gen = 0,
): { mode: ReprepareMode; requests: DocsRequest[]; lines: DocLine[]; inserts: string[]; journal: Journal } {
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
  // A line a human deleted is an edit too: then merge, so it is never written back.
  const deleted =
    stored.some((l) => states.get(l.id)!.state === "gone") ||
    carried.some((r) => !r.deleted_by_human && r.range_name && !itemSpan(tab, r.range_name));
  // Anything but our lines and blank paragraphs (a human's text, a table, an image or page break
  // (OBJECT in the text), or an element that is no paragraph at all: a gap in the paragraphs, e.g. a
  // section break or a table of contents) makes the region the humans' too: merge only.
  const tableIn = reg !== null && (tab.tables ?? []).some((t) => t.start < reg.limit && t.end > reg.start);
  let covered = reg?.start ?? 0;
  for (const p of regionParas) {
    if (p.start !== covered) break;
    covered = p.end;
  }
  const contiguous = reg !== null && covered === reg.limit;
  const pure =
    reg !== null && !deleted && !tableIn && contiguous && regionParas.every((p) => (p.text.trim() === "" && !p.text.includes(OBJECT)) || ourSpans.includes(p.start));

  if (pure && reg) {
    const numbered = profile.numbering === "numbered";
    const texts = on.map((i, n) => itemText(profile, i.label, n + 1));
    const requests: DocsRequest[] = [];
    const deletes: string[] = [];
    // Our ranges go first (named ranges change no text; only names present are deleted).
    for (const name of new Set([...stored.map((l) => l.range), ...carried.map((r) => r.range_name).filter((x): x is string => Boolean(x))])) {
      if (!tab.ranges.has(name)) continue;
      requests.push({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tab.tabId] } } });
      deletes.push(name);
    }
    requests.push({ deleteContentRange: { range: { tabId: tab.tabId, startIndex: reg.start, endIndex: reg.limit } } });
    // At reg.start now stands the tasks heading: the new paragraphs take its style, set below.
    requests.push({ insertText: { text: texts.map((t) => `${t}\n`).join(""), location: { tabId: tab.tabId, index: reg.start } } });
    const lines: DocLine[] = [];
    let at = reg.start;
    texts.forEach((text, n) => {
      const end = at + text.length;
      // The new paragraphs were split off the tasks heading: our own style, never the heading's.
      requests.push({
        updateParagraphStyle: {
          range: { tabId: tab.tabId, startIndex: at, endIndex: end },
          paragraphStyle: { namedStyleType: numbered ? "NORMAL_TEXT" : "HEADING_3" },
          fields: "namedStyleType",
        },
      });
      if (text.length) {
        requests.push({
          updateTextStyle: {
            range: { tabId: tab.tabId, startIndex: at, endIndex: end },
            textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
            fields: "bold,italic,underline,strikethrough",
          },
        });
      }
      const range = itemRange(key, n + 1, gen);
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
    return { mode: "rewrite", requests, lines, inserts: [], journal: { writes: lines.map((l) => ({ range: l.range, text: l.text, id: l.id })), deletes } };
  }

  // Merge: one batch of deletes and replaces (highest index first), inserts afterwards.
  const want = new Map(on.map((i, n) => [i.id, itemText(profile, i.label, n + 1)]));
  const ops: { index: number; requests: DocsRequest[] }[] = [];
  const lines: DocLine[] = [];
  const journal: Journal = { writes: [], deletes: [] };
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
      journal.deletes.push(line.range);
      ops.push({
        index: para!.start,
        requests: [
          { deleteNamedRange: { name: line.range, tabsCriteria: { tabIds: [tab.tabId] } } },
          { deleteContentRange: { range: { tabId: tab.tabId, startIndex: para!.start, endIndex: para!.end } } },
        ],
      });
      continue;
    }
    if (text !== line.text) {
      ops.push({ index: para!.start, requests: [replaceRange(tab.tabId, line.range, text)] });
      journal.writes.push({ range: line.range, text });
    }
    lines.push({ ...line, text });
  }
  ops.sort((a, b) => b.index - a.index);
  const known = new Set(stored.map((l) => l.id));
  return { mode: "merge", requests: ops.flatMap((o) => o.requests), lines, inserts: on.filter((i) => !known.has(i.id)).map((i) => i.id), journal };
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
  gen = 0,
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
  const range = itemRange(key, nextN(lines), gen);
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
    // After the previous item's whole block (never between "Från förra veckan" and its lines).
    const item = itemAt(scanAgenda(tab, profile), prev.start);
    const blockEnd = item ? item.blocks[item.blocks.length - 1].limit : prev.end;
    const tail = tab.paragraphs.filter((x) => !paraInTable(x) && x.start >= prev.start && x.start < blockEnd && x.text.trim() !== "").at(-1) ?? prev;
    start = tail.end;
    requests.push({ insertText: { text: `\n${text}`, location: { tabId: tab.tabId, index: tail.end - 1 } } });
    if (tail !== prev) {
      // Split off a sub-line: take the item's own paragraph style, no indent.
      requests.push({
        updateParagraphStyle: {
          range: { tabId: tab.tabId, startIndex: start, endIndex: start + text.length },
          paragraphStyle: { namedStyleType: paraStyle(prev), indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      });
    }
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
    if (old) return [toNotesItem({ ...old, text: r.text, owner: r.owner, due: r.due, done_when: r.done_when, due_date: r.due_date, anchor: r.anchor })];
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

/**
 * Before preparing again: the last run's journal (a batch that may have been written but never
 * saved) is settled against the Doc. A journaled write whose range holds exactly the journaled
 * text is ours: a stored line or row takes that text, a new item line or carried row is adopted
 * (so it is never written twice). A new carried line a human edited is adopted locked with their
 * text. Any other journaled range holding something else is a human's: its text stays, only the
 * range of ours is dropped. A journaled delete whose range is gone was ours: the stored line or
 * row goes (never read as a human's deletion). Our ranges known to neither are dropped, their
 * text kept. Never deletes text that is not exactly ours.
 */
export function planReconcile(
  tab: NotesTab,
  key: string,
  stored: DocLine[],
  carried: NoteItemRow[],
  journal: Journal | null,
): { requests: DocsRequest[]; lines: DocLine[]; carried: NoteItemRow[] } {
  let lines = stored.map((l) => ({ ...l }));
  let rows = carried.map((r) => ({ ...r }));
  const dels: { index: number; requests: DocsRequest[] }[] = [];
  const dropRange = (name: string, index: number) => dels.push({ index, requests: [{ deleteNamedRange: { name, tabsCriteria: { tabIds: [tab.tabId] } } }] });
  const exactSpan = (name: string, text: string) => {
    const span = itemSpan(tab, name);
    return span && !span.ambiguous && !span.suggested && span.rangeText === span.paraText && span.paraText === text ? span : null;
  };
  const gone = new Set((journal?.deletes ?? []).filter((d) => !tab.ranges.has(d)));
  lines = lines.filter((l) => !gone.has(l.range));
  rows = rows.filter((r) => r.deleted_by_human || !r.range_name || !gone.has(r.range_name));
  for (const w of journal?.writes ?? []) {
    const span = exactSpan(w.range, w.text);
    const line = lines.find((l) => l.range === w.range);
    const row = rows.find((r) => r.range_name === w.range);
    if (line || row) {
      if (span && line) line.text = w.text;
      if (span && row) Object.assign(row, { last_rendered_text: w.text, locked: false });
      continue;
    }
    const any = itemSpan(tab, w.range);
    if (!any) continue;
    // A new item line: adopted as ours, or (edited before the save) as the human's line it now is,
    // tracked either way so it is never inserted again.
    if (w.id && /-ag-\d+$/.test(w.range)) {
      lines = lines.filter((l) => l.id !== w.id || itemSpan(tab, l.range));
      if (!lines.some((l) => l.id === w.id)) {
        lines.push({ id: w.id, key: `ag-${nextN(lines)}`, range: w.range, text: w.text });
        continue;
      }
    }
    if (w.row && !rows.some((r) => r.carried_from_meeting === w.row!.carried_from_meeting && r.carried_from_id === w.row!.carried_from_id && !r.deleted_by_human)) {
      // A new carried line that was written but not saved: ours as written, or a human's (locked) once edited.
      rows.push(
        span
          ? { ...w.row, range_name: w.range, last_rendered_text: w.text, locked: false, deleted_by_human: false }
          : { ...w.row, range_name: w.range, last_rendered_text: w.text, locked: true, text: any.paraText, owner: null, due: null, done_when: null, due_date: null },
      );
      continue;
    }
    dropRange(w.range, any.rangeStart);
  }
  const known = new Set([...lines.map((l) => l.range), ...rows.map((r) => r.range_name).filter(Boolean), ...(journal?.writes ?? []).map((w) => w.range)]);
  for (const name of tab.ranges.keys()) {
    if (name.startsWith(`ss-${key}-`) && !known.has(name)) dropRange(name, itemSpan(tab, name)?.rangeStart ?? 0);
  }
  dels.sort((a, b) => b.index - a.index);
  return { requests: dels.flatMap((d) => d.requests), lines, carried: rows };
}
