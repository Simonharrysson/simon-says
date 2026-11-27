import { anchoredStarts, itemAt, normLabel, scanAgenda, type AgendaScan } from "@/lib/agenda/scan";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import type { FormatProfile } from "@/lib/formats/schema";
import { replaceRange, type DocsRequest } from "@/lib/google/docs";
import type { NotesItem } from "@/lib/notes/schema";
import { DONE_WHEN_LABEL, OVERDUE_MARK, PLACEHOLDER, isOverdue, stockholmDay } from "@/lib/notes/tasks";
import {
  INSERT,
  REPLACE,
  clean,
  dedupeById,
  deleteRuns,
  headerGroup,
  isEmptyItem,
  itemRangeName,
  itemSpan,
  ownedSpan,
  tabEnd,
  toNotesItem,
  type FormatPlanOpts,
  type Group,
  type RenderPlan,
} from "./notes";
import { paraBullet, paraInTable, paraLine, paraStyle, type NotesTab, type Paragraph } from "./tab";

// Rendering notes into a human's agenda Doc (meeting formats, spec "Rendering into a human Doc").
// Every v1 guarantee holds: we write only inside our own named ranges or insert NEW paragraphs;
// a human edit locks the item; a revision guard on every batch (renderItems). What is new is
// WHERE a new line goes: under its agenda item (after everything already there, human or ours),
// in the tasks section (next to the same owner's lines), in the notes section, or in an empty
// info-table cell. The insert sequences are the ones Task A1 measured on a real Doc
// (docs/learnings.md "Meeting formats A1"):
//  (b) the item already has a nested sub-bullet: "\n<line>" after the last one; the new paragraph
//      inherits its level and list. No tabs, no bullet request (a tab on a list paragraph stays text).
//  (c) no sub-bullet: "\n<line>", bullets removed, indent 54/36 pt, then a "– " prefix inserted at
//      the paragraph start (last, so no index shift). Our range covers the prefix (Ruling R-A1).
//  heading items: "\n<line>" as NORMAL_TEXT in a new BULLET_DISC_CIRCLE_SQUARE list (A1 M3).
// Levels are chosen only for new lines: a human re-indent (Tab) changes no text, so nothing ever
// re-applies a level to an existing paragraph.

export interface LineCtx {
  profile: FormatProfile;
  ownerLabel(owner: string): string;
  /** The meeting's day (YYYY-MM-DD): a carried task whose deadline is before it is marked "försenad". */
  today?: string;
}

/** The A1-measured nested insert rules, by name. */
export const NESTED_INSERT = { withSubitems: "inherit-after-subitem", withoutSubitems: "indent-no-list" } as const;

/** Prefix of our (c)-style lines under a list item without sub-bullets. Part of the range (R-A1). */
export const DASH = "– ";
/** Prefix of the attendee line when the Doc has no Närvarande cell. */
export const ATTENDEES_PREFIX = "Närvarande: ";
const C_INDENT_START = 54;
const C_INDENT_FIRST = 36;

const ATTENDEES_ROW = "info-narvarande";
const ATTENDEES_ANCHOR = "info.narvarande";

/** Cleaned text with a final "." unless it already ends in ".", "!" or "?". */
export function sentence(s: string): string {
  const t = clean(s);
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The single line we render for an item (without a placement prefix). Never contains a newline.
 * - `info.*` anchors, attendees and "now": the text as is (F1: "18:05–19:10" gets no ".");
 * - decision: "<decisionPrefix> <sentence>";
 * - task: "<label>: <text without final period>[ (<due>)][ – klart när: <doneWhen>].[ ✓ klart]" (no
 *   owner: no label). With `placeholders` the missing ones read "(vem?)", "(deadline?)",
 *   "(klart när?)"; a carried task past its deadline (`dueDate` before `ctx.today`) gets
 *   "(<due>, försenad)";
 * - note: <sentence>.
 */
export function formatLine(
  item: Pick<NotesItem, "section" | "text"> &
    Partial<Pick<NotesItem, "id" | "owner" | "due" | "anchor" | "done" | "doneWhen" | "placeholders" | "carried" | "dueDate">>,
  ctx: LineCtx,
): string {
  const raw = clean(item.text);
  if (item.anchor?.startsWith("info.") || item.section === "attendees" || item.section === "now") return raw;
  // A leading dash or bullet typed into the text would read as our (c) prefix: drop it.
  const text = raw.replace(/^[–•-]\s+/, "");
  switch (item.section) {
    case "decision":
      return `${clean(ctx.profile.decisionPrefix)} ${sentence(text)}`;
    case "action": {
      const ask = item.placeholders === true && !item.done && !item.carried;
      const owner = item.owner ? clean(ctx.ownerLabel(clean(item.owner))) : ask ? PLACEHOLDER.owner : "";
      const body = text.replace(/[.\s]+$/, "");
      const overdue = item.carried && !item.done && ctx.today && isOverdue(item.dueDate, ctx.today);
      const due = item.due ? `(${clean(item.due)}${overdue ? `, ${OVERDUE_MARK}` : ""})` : ask ? PLACEHOLDER.due : "";
      const doneWhen = item.doneWhen ? `${DONE_WHEN_LABEL} ${clean(item.doneWhen).replace(/[.\s]+$/, "")}` : ask ? PLACEHOLDER.doneWhen : "";
      let line = `${owner ? `${owner}: ` : ""}${body}`;
      if (due) line += ` ${due}`;
      if (doneWhen) line += ` – ${doneWhen}`;
      if (due || doneWhen || !/[!?]$/.test(body)) line += ".";
      if (item.done) line += " ✓ klart";
      return line;
    }
    default:
      return sentence(text);
  }
}

const isTaskPrimary = (item: NotesItem) =>
  item.section === "action" && !item.copyOf && !item.carried && !item.id.endsWith("-t") && item.anchor !== "tasks";

/**
 * Desired items plus the tasks-section copies: each unlocked task primary (not carried, not
 * already in the tasks section) gets `{ ...item, id: "<id>-t", anchor: "tasks", copyOf: id }`
 * when the profile has a tasks section. Each copy locks on its own (Ruling R-A6): a copy whose
 * primary is locked or deleted by a human keeps rendering on its own — from the copy item when the
 * caller passes one (A12 gives the copy to Claude then), else from its row — and takes the
 * primary's `done` (so "✓ klart" still reaches the tasks section). No new copy is made for a
 * primary that is locked or deleted without one.
 */
export function expandCopies(items: NotesItem[], rows: NoteItemRow[], profile: FormatProfile): NotesItem[] {
  items = dedupeById(items);
  if (!profile.tasksSection) return items;
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out = [...items];
  const have = new Set(items.map((i) => i.id));
  const add = (item: NotesItem) => {
    if (have.has(item.id)) return;
    have.add(item.id);
    out.push(item);
  };
  const itemById = new Map(items.map((i) => [i.id, i]));
  /** The copy of a human-edited primary: its own item or row, with the primary's done. */
  const ownCopy = (copy: NoteItemRow, primaryDone: boolean) => {
    const base = toNotesItem(copy);
    add(primaryDone && !base.done ? { ...base, done: true } : base);
  };
  for (const item of items) {
    if (!isTaskPrimary(item)) continue;
    const row = rowById.get(item.id);
    const copyId = `${item.id}-t`;
    if (row?.locked || row?.deleted_by_human) {
      const copy = rowById.get(copyId);
      const given = itemById.get(copyId);
      if (given && item.done && !given.done) out[out.indexOf(given)] = { ...given, done: true };
      else if (copy) ownCopy(copy, item.done === true || row.done === true);
      continue;
    }
    add({ ...item, id: copyId, anchor: "tasks", copyOf: item.id });
  }
  // Copies whose primary is gone from the items because a human deleted (or locked) it.
  for (const r of rows) {
    if (!r.copy_of) continue;
    const primary = rowById.get(r.copy_of);
    if (primary?.locked || primary?.deleted_by_human) ownCopy(r, primary.done === true);
  }
  return out;
}

/**
 * The tab without the paragraphs our rows' ranges touch, for scanning: our own lines must never
 * change which paragraphs are agenda items (e.g. our bullet list under a bold item would end a
 * bold-only Doc's "no lists" rule, R-A5 (1)). Indices are unchanged; only paragraphs are left out.
 * A12 scans through this too (F4).
 */
export function withoutOwnLines(tab: NotesTab, rows: NoteItemRow[]): NotesTab {
  const spans = rows
    .filter((r) => r.range_name && !r.deleted_by_human)
    .map((r) => itemSpan(tab, r.range_name!))
    .filter((x): x is NonNullable<typeof x> => x !== null && !tab.paragraphs.some((p) => p.start === x.paraStart && paraInTable(p)));
  if (!spans.length) return tab;
  return { ...tab, paragraphs: tab.paragraphs.filter((p) => !spans.some((sp) => p.start >= sp.paraStart && p.start < sp.paraEnd)) };
}

/** The placement prefix a rendered row carries in front of its formatLine. */
function prefixOf(row: NoteItemRow): string {
  const last = row.last_rendered_text ?? "";
  if (row.anchor?.startsWith("ag-") && last.startsWith(DASH)) return DASH;
  if (row.anchor === ATTENDEES_ANCHOR && last.startsWith(ATTENDEES_PREFIX)) return ATTENDEES_PREFIX;
  return "";
}

type Mode = "b" | "c" | "bullet" | "plain" | "cell";
interface Slot {
  /** Doc index of the insert: before the newline of the paragraph we go after, or a cell's start. */
  at: number;
  mode: Mode;
  /** The paragraph we go after (not for "cell"). */
  after: Paragraph | null;
  /** Sort key inside a merged insert (lower first); ties keep desired order. */
  rank: number;
  item: NotesItem;
  line: string;
}

export type FormatRenderOpts = FormatPlanOpts;

/**
 * The requests that take an agenda Doc from `rows` to `desired` (same contract as v1's
 * planRender, highest index first, `tabId` on every request):
 * - changes / removals / locks exactly as v1, with formatLine (+ the row's placement prefix);
 * - new `ag-*` items after the last non-empty paragraph of the item's last block, by the A1 rule;
 * - new `tasks` items as NORMAL_TEXT after the last line starting with the same "<label>: ",
 *   else at the end of the tasks block; `notes` at the end of the notes block;
 * - row `info-narvarande` into the empty Närvarande cell, or after the LIVE line when the Doc has
 *   no such cell; a cell holding human text gets nothing;
 * - items whose anchor is gone or unknown are not inserted;
 * - `newAnchors` → one createNamedRange each; the header exactly as v1.
 */
export function planFormatRender(
  meeting: MeetingRow,
  tab: NotesTab,
  rows: NoteItemRow[],
  desired: NotesItem[],
  opts: FormatRenderOpts,
): RenderPlan {
  desired = dedupeById(desired);
  const tabId = meeting.notes_tab_id;
  const ctx: LineCtx = { profile: opts.profile, ownerLabel: opts.ownerLabel, ...(meeting.started_at ? { today: stockholmDay(meeting.started_at) } : {}) };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const desiredIds = new Set(desired.map((d) => d.id));
  const groups: Group[] = [];
  const applied = new Set<string>();
  const removed = new Set<string>();
  const lines = new Map<string, string>();
  const anchors = (meeting.section_ranges ?? {}) as Record<string, unknown>;
  const rangeOf = (key: string) => (typeof anchors[key] === "string" ? (anchors[key] as string) : null);

  // Removals (v1 rules). Never a cell row: deleting a cell's paragraph would take its newline.
  for (const row of rows) {
    if (desiredIds.has(row.id) || row.anchor?.startsWith("info.")) continue;
    const span = ownedSpan(tab, row);
    if (!span || span.paraText !== row.last_rendered_text) continue;
    if (tab.paragraphs.some((p) => p.start === span.paraStart && paraInTable(p))) continue;
    removed.add(row.id);
  }
  groups.push(...deleteRuns(tab, rows, removed, { keepHumanNewline: true }));
  const doomed: { start: number; end: number }[] = [];
  for (const id of removed) {
    const span = itemSpan(tab, byId.get(id)!.range_name!);
    if (span) doomed.push({ start: span.paraStart, end: span.paraEnd });
  }
  const alive = (p: Paragraph) => !doomed.some((d) => p.start >= d.start && p.start < d.end);
  const nonEmpty = (p: Paragraph) => paraLine(p).trim() !== "";

  // Changes, and the new items to place.
  const fresh: NotesItem[] = [];
  for (const item of desired) {
    const row = byId.get(item.id);
    if (row?.locked || row?.deleted_by_human || isEmptyItem(item)) continue;
    if (!row?.range_name) {
      // Already in the Doc (a render whose rows were not saved): never insert a second copy.
      if (tab.ranges.has(itemRangeName(meeting.id, item.id))) continue;
      fresh.push(item);
      continue;
    }
    const span = ownedSpan(tab, row);
    if (!span) continue;
    const text = prefixOf(row) + formatLine({ ...item, section: row.section, anchor: row.anchor ?? item.anchor }, ctx);
    applied.add(item.id);
    lines.set(item.id, text);
    if (span.rangeText === text) continue;
    groups.push({ index: span.rangeStart, kind: REPLACE, requests: [replaceRange(tabId, row.range_name, text)] });
  }

  // Where each new item goes.
  let scan: AgendaScan | null = null;
  // Items from the anchors (and the ones created in this batch), the mode fixed at the start (R1-I1).
  const anchoredAt = () => {
    const created = (opts.newAnchors ?? [])
      .map((a) => tab.paragraphs.find((x) => !paraInTable(x) && a.start >= x.start && a.start < x.end)?.start)
      .filter((x): x is number => x !== undefined);
    return [...anchoredStarts(tab, anchors, meeting.id), ...created];
  };
  const scanned = () => (scan ??= scanAgenda(withoutOwnLines(tab, rows), opts.profile, { anchors: anchoredAt() }));
  const anchorStart = (key: string): number | null => {
    const name = rangeOf(key);
    const span = name ? itemSpan(tab, name) : null;
    if (span) return span.paraStart;
    const created = opts.newAnchors?.find((a) => a.key === key);
    if (!created) return null;
    const p = tab.paragraphs.find((x) => created.start >= x.start && created.start < x.end);
    return p ? p.start : null;
  };
  /**
   * Start of the next anchor paragraph (agenda item, tasks, notes, signatures) after `start`, else the end of
   * the tab. For the tasks block the LIVE line ends it too (a format without a notes section has
   * the LIVE line after the tasks; in the notes section the LIVE line is the block's first line).
   */
  const blockLimit = (start: number, endsAtLive: boolean): number => {
    const live = meeting.header_range ?? rangeOf("live");
    const liveSpan = endsAtLive && live ? itemSpan(tab, live) : null;
    const starts = [
      liveSpan?.paraStart ?? null,
      // "signatures": the signature lines after the tasks (A7) are never inside the tasks block.
      ...Object.keys(anchors).filter((k) => k.startsWith("ag-") || k === "tasks" || k === "notes" || k === "signatures").map(anchorStart),
      ...scanned().items.map((i) => i.paraStart),
      scanned().tasksHeading?.start ?? null,
      scanned().notesHeading?.start ?? null,
    ].filter((s): s is number => s !== null && s > start);
    return starts.length ? Math.min(...starts) : tabEnd(tab);
  };
  /** Body paragraphs in [from, limit) that may anchor an insert: not in a table, not empty, not deleted now. */
  const usable = (from: number, limit: number) =>
    tab.paragraphs.filter((p) => p.start >= from && p.start < limit && !paraInTable(p) && nonEmpty(p) && alive(p));

  const slots: Slot[] = [];
  fresh.forEach((item, order) => {
    const key = item.anchor;
    if (!key) return;
    const line = formatLine(item, ctx);
    if (key.startsWith("ag-")) {
      const start = anchorStart(key);
      const agItem = start === null ? null : itemAt(scanned(), start);
      if (!agItem) return;
      const block = agItem.blocks[agItem.blocks.length - 1];
      const after = usable(block.start, block.limit).at(-1);
      if (!after) return;
      // (b) only into a sub-point exactly one level below the item (heading items: level 0 of a
      // sub-point list); after a deeper point (a human's sub-sub-point, or ours after a human Tab)
      // our line would become a child of someone else's point → (c) instead.
      const bullet = paraBullet(after);
      const subLevel = agItem.kind === "list" ? agItem.level + 1 : 0;
      // A new bullet list only under a HEADING_* item. Under a bold / typed-number / "<label>:"
      // line our list would be the one list in a list-free agenda: "– " lines instead (R1-I1).
      const itemPara = tab.paragraphs.find((x) => x.start === agItem.paraStart);
      const headingItem = agItem.kind === "heading" && Boolean(itemPara && paraStyle(itemPara).startsWith("HEADING_"));
      const mode: Mode =
        bullet && after.start !== agItem.paraStart && bullet.level === subLevel
          ? "b"
          : headingItem && !bullet
            ? "bullet"
            : "c";
      slots.push({ at: after.end - 1, mode, after, rank: order, item, line: mode === "c" ? DASH + line : line });
      return;
    }
    if (key === "tasks" || key === "notes") {
      const start = anchorStart(key);
      if (start === null) return;
      const paras = usable(start, blockLimit(start, key === "tasks"));
      let after = paras.at(-1);
      let rank = 1_000_000 + order;
      if (key === "tasks" && item.section === "action" && item.owner) {
        const label = `${clean(ctx.ownerLabel(clean(item.owner)))}: `;
        const same = paras.filter((p) => paraLine(p).startsWith(label)).at(-1);
        if (same) {
          after = same;
          rank = order;
        } else {
          // Lines with a label new to the block stay together, in first-seen order.
          const firstSeen = fresh.findIndex((f) => f.anchor === "tasks" && f.owner && clean(ctx.ownerLabel(clean(f.owner))) === label.slice(0, -2));
          rank = 1_000_000 + firstSeen * 1000 + order;
        }
      }
      if (!after) return;
      slots.push({ at: after.end - 1, mode: "plain", after, rank, item, line });
      return;
    }
    if (key === ATTENDEES_ANCHOR && item.id === ATTENDEES_ROW) {
      const cell = scanned().info.find((c) => normLabel(c.field) === "närvarande");
      if (cell) {
        // Only an empty cell is ours to fill (the tab, not the scan's copy, is the truth).
        const p = tab.paragraphs.find((x) => x.start === cell.valueCell.paragraphStart);
        const inCell = p?.inTable;
        const cellText = inCell
          ? tab.paragraphs.filter((x) => x.inTable && x.inTable.table === inCell.table && x.inTable.row === inCell.row && x.inTable.col === inCell.col).map((x) => x.text).join("")
          : null;
        if (cellText === null || cellText.trim() !== "") return;
        slots.push({ at: cell.valueCell.paragraphStart, mode: "cell", after: null, rank: order, item, line });
        return;
      }
      const live = meeting.header_range ?? rangeOf("live");
      const span = live ? itemSpan(tab, live) : null;
      if (!span) return;
      slots.push({ at: span.paraEnd - 1, mode: "plain", after: null, rank: -1, item, line: ATTENDEES_PREFIX + line });
    }
    // Any other anchor (info.* without a range, unknown keys): not inserted.
  });

  // One insert per index (two inserts at one index would come out reversed).
  const byAt = new Map<number, Slot[]>();
  for (const slot of slots) {
    const list = byAt.get(slot.at) ?? [];
    // A second placement mode at the same index waits for the next render.
    if (list.length && list[0].mode !== slot.mode) continue;
    list.push(slot);
    byAt.set(slot.at, list);
  }
  for (const [at, list] of byAt) {
    list.sort((a, b) => a.rank - b.rank);
    groups.push(insertGroup(tabId, meeting.id, at, list));
    for (const s of list) {
      applied.add(s.item.id);
      lines.set(s.item.id, s.line);
    }
  }

  // New anchors (A12: agenda items a human added during the meeting).
  for (const a of opts.newAnchors ?? []) {
    groups.push({
      index: a.start,
      kind: INSERT,
      requests: [{ createNamedRange: { name: `ss-${meeting.id}-${a.key}`, range: { tabId, startIndex: a.start, endIndex: a.end } } }],
    });
  }

  const head = headerGroup(meeting, tab, opts.headerText);
  if (head.group) groups.push(head.group);

  groups.sort((a, b) => b.index - a.index || a.kind - b.kind);
  return { requests: groups.flatMap((g) => g.requests), applied, removed, header: head.header, lines };
}

/** The requests for the lines placed at one index, by their (shared) mode. */
function insertGroup(tabId: string, meetingId: string, at: number, slots: Slot[]): Group {
  const mode = slots[0].mode;
  const range = (startIndex: number, endIndex: number) => ({ tabId, startIndex, endIndex });
  const named = (s: Slot, start: number): DocsRequest => ({
    createNamedRange: { name: itemRangeName(meetingId, s.item.id), range: range(start, start + s.line.length) },
  });

  // Inserted text takes the previous character's style (bold label, link, …): ours is plain.
  const plainText = (start: number, end: number): DocsRequest => ({
    updateTextStyle: {
      range: range(start, end),
      textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
      fields: "bold,italic,underline,strikethrough,link",
    },
  });

  if (mode === "cell") {
    // One attendee row at most; an empty cell's paragraph is [at, at+1).
    const s = slots[0];
    return {
      index: at,
      kind: INSERT,
      requests: [{ insertText: { text: s.line, location: { tabId, index: at } } }, named(s, at), plainText(at, at + s.line.length)],
    };
  }

  // The text without placement prefixes: (c) inserts its "– " after the bullets are gone.
  const bare = slots.map((s) => (mode === "c" ? s.line.slice(DASH.length) : s.line));
  const requests: DocsRequest[] = [{ insertText: { text: `\n${bare.join("\n")}`, location: { tabId, index: at } } }];
  const starts: number[] = [];
  let offset = at + 1;
  for (const t of bare) {
    starts.push(offset);
    offset += t.length + 1;
  }
  const end = offset - 1; // end of the last new line's text (its newline is the old paragraph's)

  if (mode === "b") {
    slots.forEach((s, i) => requests.push(named(s, starts[i])));
  } else if (mode === "plain" || mode === "bullet") {
    const afterBullet = mode === "plain" && slots[0].after && paraBullet(slots[0].after);
    if (afterBullet) {
      // After a human's bulleted line our plain line would inherit the bullet: remove it and the
      // list indent it leaves behind.
      requests.push({ deleteParagraphBullets: { range: range(at + 1, end) } });
      requests.push({
        updateParagraphStyle: {
          range: range(at + 1, end),
          paragraphStyle: { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      });
    } else {
      requests.push({
        updateParagraphStyle: { range: range(at + 1, end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" },
      });
    }
    if (mode === "bullet") {
      requests.push({ createParagraphBullets: { range: range(at + 1, end), bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    }
    slots.forEach((s, i) => requests.push(named(s, starts[i])));
  } else {
    // (c): the new paragraphs inherit the list paragraph's bullet when we go after one.
    if (slots[0].after && paraBullet(slots[0].after)) requests.push({ deleteParagraphBullets: { range: range(at + 1, end) } });
    requests.push({
      updateParagraphStyle: {
        range: range(at + 1, end),
        paragraphStyle: {
          namedStyleType: "NORMAL_TEXT",
          indentStart: { magnitude: C_INDENT_START, unit: "PT" },
          indentFirstLine: { magnitude: C_INDENT_FIRST, unit: "PT" },
        },
        fields: "namedStyleType,indentStart,indentFirstLine",
      },
    });
    // Prefixes last-to-first, so each start is still valid when its insert runs.
    for (let i = starts.length - 1; i >= 0; i--) {
      requests.push({ insertText: { text: DASH, location: { tabId, index: starts[i] } } });
    }
    slots.forEach((s, i) => requests.push(named(s, starts[i] + DASH.length * i)));
  }
  requests.push(plainText(at + 1, mode === "c" ? end + DASH.length * slots.length : end));
  return { index: at, kind: INSERT, requests };
}
