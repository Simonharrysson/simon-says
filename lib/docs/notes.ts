import { parseNotesTab, type NotesTab } from "./tab";
import type { OAuth2Client } from "google-auth-library";
import { kindOfSection, type MeetingRow, type NoteItemRow, type NoteSection } from "@/lib/db/types";
import type { FormatProfile } from "@/lib/formats/schema";
import { docsApi, isRevisionConflict, replaceRange, type DocsRequest } from "@/lib/google/docs";
import type { NotesItem } from "@/lib/notes/schema";

// Notes items in the notes tab: one paragraph per item, one named range `ss-<meetingId>-<itemId>`
// over the item's text. What Task 2 measured on a real Doc decides the rules here:
// - typing at a range's very start or end lands OUTSIDE the range, and Enter inside a range
//   leaves one range spanning two paragraphs. So a human edit is detected on the whole
//   paragraph(s) the range touches, compared with the full line we last rendered;
// - replaceNamedRangeContent touches only its range, so it is safe on unedited items;
// - a stale requiredRevisionId gives 400 "...does not match the latest revision." → 'conflict'.
// The service never writes to an item a human edited (locked) or deleted, and never removes
// text outside its own items. The single "now" item is never locked.

export const itemRangeName = (meetingId: string, itemId: string) => `ss-${meetingId}-${itemId}`;

export function clean(s: string): string {
  // Newlines, vertical tab (Docs' soft line break), other control and separator characters → space.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The single line we render for an item (what `last_rendered_text` stores). Never contains a newline. */
export function formatItem(item: Pick<NotesItem, "section" | "text" | "owner" | "due">): string {
  const text = clean(item.text);
  const owner = item.owner ? clean(item.owner) : "";
  const due = item.due ? clean(item.due) : "";
  switch (item.section) {
    case "action":
      return `☐ ${owner ? `${owner}: ` : ""}${text}${due ? ` (${due})` : ""}`;
    case "decision":
      return `✓ ${text}`;
    default:
      return text;
  }
}

export function toNotesItem(row: NoteItemRow): NotesItem {
  return {
    id: row.id,
    section: row.section,
    text: row.text,
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.due ? { due: row.due } : {}),
    // Format fields only when set, so a v1 row maps to exactly the v1 item.
    ...(row.anchor ? { anchor: row.anchor } : {}),
    ...(row.done ? { done: true } : {}),
    ...(row.copy_of ? { copyOf: row.copy_of } : {}),
    ...(row.carried_from_id != null ? { carried: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the notes tab

export { parseNotesTab, cellAt } from "./tab";
export type { NotesTab, Paragraph, Table, TableCell } from "./tab";

export interface ItemSpan {
  rangeStart: number;
  rangeEnd: number;
  /** Text inside the range (parts joined by the text between them). */
  rangeText: string;
  /** From the start of the first paragraph the range touches to the end of the last one. */
  paraStart: number;
  paraEnd: number;
  /** Those paragraphs' text, trailing newline dropped. */
  paraText: string;
  /** More than one named range carries this name (e.g. a copy-paste). */
  ambiguous: boolean;
  /** A human's pending suggestion touches these paragraphs. */
  suggested: boolean;
}

/** Where a named range sits, or null when it is gone or empty (deleted by a human). */
export function itemSpan(tab: NotesTab, name: string): ItemSpan | null {
  const entries = tab.ranges.get(name);
  const parts = (entries ?? []).flat().filter((p) => p.end > p.start);
  if (!parts.length) return null;
  const rangeStart = Math.min(...parts.map((p) => p.start));
  const rangeEnd = Math.max(...parts.map((p) => p.end));
  let touched = tab.paragraphs.filter((p) => p.start < rangeEnd && p.end > rangeStart);
  if (!touched.length) return null;
  // A range in a table cell (A1 human stage: typing at a cell's edge lands outside the range):
  // the span is the whole cell, so any edit anywhere in it makes rangeText differ from paraText.
  const cell = touched[0].inTable;
  if (cell) {
    touched = tab.paragraphs.filter(
      (p) => p.inTable && p.inTable.table === cell.table && p.inTable.row === cell.row && p.inTable.col === cell.col,
    );
  }
  const first = tab.paragraphs.indexOf(touched[0]);
  const last = tab.paragraphs.indexOf(touched[touched.length - 1]);
  const paras = tab.paragraphs.slice(first, last + 1);
  const joined = paras.map((p) => p.text).join("");
  const paraStart = paras[0].start;
  const paraEnd = paras[paras.length - 1].end;
  return {
    rangeStart,
    rangeEnd,
    rangeText: joined.slice(rangeStart - paraStart, rangeEnd - paraStart),
    paraStart,
    paraEnd,
    paraText: joined.endsWith("\n") ? joined.slice(0, -1) : joined,
    ambiguous: (entries?.length ?? 0) > 1,
    suggested: paras.some((p) => p.suggested),
  };
}

/** Current text of each rendered item: its whole paragraph(s); null when the range is gone. */
export function currentItems(tab: NotesTab, rows: NoteItemRow[]): Map<string, string | null> {
  return readCurrent(tab, rows).current;
}

/** Ids of rendered items with a human's pending suggestion in their paragraph(s). */
export function suggestedItems(tab: NotesTab, rows: NoteItemRow[]): Set<string> {
  return readCurrent(tab, rows).suggested;
}

function readCurrent(tab: NotesTab, rows: NoteItemRow[]) {
  const current = new Map<string, string | null>();
  const suggested = new Set<string>();
  for (const row of rows) {
    if (!row.range_name || row.deleted_by_human) continue;
    const span = itemSpan(tab, row.range_name);
    current.set(row.id, span ? span.paraText : null);
    if (span?.suggested) suggested.add(row.id);
  }
  return { current, suggested };
}

// The last read per Doc revision, so renderItems builds its indices from exactly the revision it
// writes against without a second documents.get. A revision id identifies the content.
const snapshots = new Map<string, NotesTab>();
const snapshotKey = (docId: string, tabId: string, revisionId: string) => `${docId}\u0000${tabId}\u0000${revisionId}`;

/** documents.get of the notes tab (suggestions inline), remembered so renderItems at that revision needs no second read. */
export async function readNotesTab(auth: OAuth2Client, docId: string, tabId: string): Promise<NotesTab> {
  return fetchTab(auth, docId, tabId);
}

async function fetchTab(auth: OAuth2Client, docId: string, tabId: string): Promise<NotesTab> {
  // Suggestions inline, so a human's pending suggestion is visible (and locks the item).
  const doc = (
    await docsApi(auth).documents.get({
      documentId: docId,
      includeTabsContent: true,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
    })
  ).data;
  const tab = parseNotesTab(doc, tabId);
  snapshots.set(snapshotKey(docId, tabId, tab.revisionId), tab);
  while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value as string);
  return tab;
}

export async function readItems(
  auth: OAuth2Client,
  docId: string,
  tabId: string,
  rows: NoteItemRow[],
): Promise<{ revisionId: string; current: Map<string, string | null>; suggested: Set<string> }> {
  const tab = await fetchTab(auth, docId, tabId);
  return { revisionId: tab.revisionId, ...readCurrent(tab, rows) };
}

// ---------------------------------------------------------------------------------------------
// Human-edit detection

/**
 * Compare each rendered item's paragraph text with what we last rendered. Different → locked
 * with the human's text (kept verbatim from now on); range gone → deleted_by_human (never
 * re-added). Already-locked items stay locked with their text refreshed. The "now" item is
 * never locked. Rows never rendered (no range yet) and rows missing from `current` are unchanged.
 * An item with a human's pending suggestion (`suggested`, from readItems) is locked too.
 */
export function diffHumanEdits(
  rows: NoteItemRow[],
  current: Map<string, string | null>,
  suggested: Set<string> = new Set(),
): { locked: NotesItem[]; deletedIds: string[]; rows: NoteItemRow[] } {
  const locked: NotesItem[] = [];
  const deletedIds: string[] = [];
  const out: NoteItemRow[] = [];
  for (const row of rows) {
    let next = row;
    const cur = current.get(row.id);
    if (row.deleted_by_human) {
      // stays deleted
    } else if (!row.range_name || row.last_rendered_text == null || cur === undefined) {
      // not rendered yet, or not read: unchanged
    } else if (cur === null) {
      next = { ...row, deleted_by_human: true };
    } else if (row.section === "now") {
      // never locked: always reflects the current topic
    } else if (row.locked || cur !== row.last_rendered_text || suggested.has(row.id)) {
      next = { ...row, locked: true, text: cur, owner: null, due: null };
    }
    if (next.deleted_by_human) deletedIds.push(next.id);
    else if (next.locked) locked.push(toNotesItem(next));
    out.push(next);
  }
  return { locked, deletedIds, rows: out };
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** Requests that go together at one Doc index (sorted highest index first, then by kind). */
export type Group = { index: number; kind: 0 | 1 | 2; requests: DocsRequest[] };
export const DELETE = 0;
export const INSERT = 1;
export const REPLACE = 2;

function sectionAnchor(meeting: MeetingRow, section: NoteSection): string | null {
  const v = (meeting.section_ranges ?? {})[section];
  return typeof v === "string" ? v : null;
}

/**
 * An item's span when we may write to it: present, unique, its range covering its whole
 * paragraph(s), and (except "now") those paragraphs exactly what we rendered. A range that no
 * longer covers its paragraph (e.g. an edge character deleted and retyped, which lands outside
 * the range) would make a replace leave that character behind, so it is not written either.
 */
export function ownedSpan(tab: NotesTab, row: NoteItemRow): ItemSpan | null {
  if (!row.range_name || row.locked || row.deleted_by_human) return null;
  const span = itemSpan(tab, row.range_name);
  if (!span || span.ambiguous || span.suggested || span.rangeText !== span.paraText) return null;
  if (row.section !== "now" && span.paraText !== row.last_rendered_text) return null;
  // "now" is never locked, but a paragraph a human typed after Enter inside its range is theirs:
  // replacing the range would erase it. (Our "now" text is always one paragraph.)
  if (row.section === "now" && span.paraText.includes("\n")) return null;
  return span;
}

export interface RenderPlan {
  requests: DocsRequest[];
  /** Items whose line in the Doc is now `formatItem(item)`: replaced, inserted, or already equal. */
  applied: Set<string>;
  /** Unlocked items whose paragraph and range are deleted. */
  removed: Set<string>;
  /** The header line written, if the header is replaced. */
  header: string | null;
  /**
   * Format layout only: the exact line now in the Doc per applied item (incl. a "– " or
   * "Närvarande: " prefix). renderedRows stores it as `last_rendered_text`; v1 plans leave it out.
   */
  lines?: Map<string, string>;
}

/** What `renderItems` passes to the injected format planner (pre-flight F12: no import cycle). */
export interface FormatPlanOpts {
  profile: FormatProfile;
  ownerLabel(owner: string): string;
  headerText?: string;
  newAnchors?: { key: string; start: number; end: number }[];
}
export type FormatPlanner = (
  meeting: MeetingRow,
  tab: NotesTab,
  rows: NoteItemRow[],
  desired: NotesItem[],
  opts: FormatPlanOpts,
) => RenderPlan;

/** An item we refuse to render: nothing visible left after cleaning. */
export const isEmptyItem = (item: NotesItem) => clean(item.text) === "";

/** One item per id, the last occurrence winning (at the first occurrence's place). Same array when there is no duplicate. */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return byId.size === items.length ? items : [...byId.values()];
}

/** End of the tab's last paragraph (a Doc never ends in a table). */
export const tabEnd = (tab: NotesTab) => (tab.paragraphs.length ? tab.paragraphs[tab.paragraphs.length - 1].end : 1);

/**
 * Delete requests for the `removed` rows' paragraphs and ranges (each must have an owned span):
 * adjacent paragraphs become one run, so deletes never overlap; a run reaching the end of the tab
 * takes the newline before it instead (the final newline cannot be deleted).
 */
export function deleteRuns(
  tab: NotesTab,
  rows: NoteItemRow[],
  removed: Set<string>,
  opts: { keepHumanNewline?: boolean } = {},
): Group[] {
  const tabId = tab.tabId;
  const lastIndex = tabEnd(tab);
  const doomed: { start: number; end: number; name: string }[] = [];
  for (const row of rows) {
    if (!removed.has(row.id)) continue;
    const span = ownedSpan(tab, row);
    if (!span) continue;
    doomed.push({ start: span.paraStart, end: span.paraEnd, name: row.range_name! });
  }
  doomed.sort((a, b) => a.start - b.start);
  const runs: { start: number; end: number; names: string[] }[] = [];
  for (const d of doomed) {
    const run = runs.at(-1);
    if (run && d.start <= run.end) {
      run.end = Math.max(run.end, d.end);
      run.names.push(d.name);
    } else runs.push({ start: d.start, end: d.end, names: [d.name] });
  }
  const groups: Group[] = [];
  // Paragraphs of our rows that stay (their newline may be taken by a run at the end of the tab).
  const kept = rows
    .filter((r) => r.range_name && !removed.has(r.id) && !r.deleted_by_human)
    .map((r) => itemSpan(tab, r.range_name!))
    .filter((x): x is ItemSpan => x !== null);
  const tables = tab.tables ?? [];
  for (const run of runs) {
    const isLast = run.end >= lastIndex;
    // Format layout: the newline before the run belongs to a human paragraph (or ends a table,
    // which the API refuses to delete) → leave it (and our now-empty last paragraph) rather than
    // merge the human's text into our paragraph.
    const prevIsHuman =
      opts.keepHumanNewline &&
      run.start > 1 &&
      (tables.some((t) => t.end === run.start) || !kept.some((sp) => run.start - 1 >= sp.paraStart && run.start - 1 < sp.paraEnd));
    const start = isLast && !prevIsHuman ? Math.max(1, run.start - 1) : run.start;
    let end = isLast ? lastIndex - 1 : run.end;
    // Format layout: never the newline directly before a table (API 400 "Invalid deletion range",
    // measured: check-agenda-render tablenl): our text goes, an empty paragraph stays.
    if (opts.keepHumanNewline && !isLast && tables.some((t) => t.start === run.end)) end = run.end - 1;
    const requests: DocsRequest[] = run.names.map((name) => ({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } }));
    if (end > start) requests.push({ deleteContentRange: { range: { tabId, startIndex: start, endIndex: end } } });
    groups.push({ index: start, kind: DELETE, requests });
  }
  return groups;
}

/**
 * The header (LIVE) line: replaced only while its range covers exactly the single paragraph we
 * last wrote (null = not recorded yet: the coverage check alone).
 */
export function headerGroup(meeting: MeetingRow, tab: NotesTab, headerText: string | undefined): { group: Group | null; header: string | null } {
  if (headerText === undefined || !meeting.header_range) return { group: null, header: null };
  const span = itemSpan(tab, meeting.header_range);
  const text = clean(headerText);
  const owned =
    span &&
    !span.ambiguous &&
    !span.suggested &&
    span.rangeText === span.paraText &&
    !span.paraText.includes("\n") &&
    (meeting.header_rendered == null || span.paraText === meeting.header_rendered);
  if (owned && text !== "" && span.rangeText !== text) {
    return {
      group: { index: span.rangeStart, kind: REPLACE, requests: [replaceRange(meeting.notes_tab_id, meeting.header_range, text)] },
      header: text,
    };
  }
  return { group: null, header: null };
}

/**
 * The requests that take the notes tab from `rows` to `desired`, built from `tab` (the revision
 * the write is guarded with), ordered from the highest Doc index to the lowest.
 * - changed unlocked items: replaceNamedRangeContent (only when the range text differs);
 * - new items: one insertText per section after the section's last item (or its anchor), plus
 *   a named range per item;
 * - unlocked items missing from `desired`: their paragraph and range deleted (adjacent ones as
 *   one run);
 * - locked, human-deleted, suggested-on and empty items: never touched, never (re-)added;
 * - the header only when its range still covers exactly the line we last wrote.
 */
export function planRender(
  meeting: MeetingRow,
  tab: NotesTab,
  rows: NoteItemRow[],
  desired: NotesItem[],
  headerText?: string,
): RenderPlan {
  const tabId = meeting.notes_tab_id;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const desiredIds = new Set(desired.map((d) => d.id));
  const groups: Group[] = [];
  const applied = new Set<string>();
  const removed = new Set<string>();
  let header: string | null = null;

  // Removals first, so inserts never anchor on an item deleted in the same batch.
  const lastIndex = tabEnd(tab);
  for (const row of rows) {
    if (desiredIds.has(row.id)) continue;
    const span = ownedSpan(tab, row);
    // Only remove a paragraph that holds nothing but our line.
    if (!span || span.paraText !== row.last_rendered_text) continue;
    removed.add(row.id);
  }
  groups.push(...deleteRuns(tab, rows, removed));

  // Changes and new items.
  const pending = new Map<NoteSection, NotesItem[]>();
  for (const item of desired) {
    const row = byId.get(item.id);
    if (row?.locked || row?.deleted_by_human || isEmptyItem(item)) continue;
    if (!row?.range_name) {
      // Already in the Doc (a render whose rows were not saved): never insert a second copy.
      if (tab.ranges.has(itemRangeName(meeting.id, item.id))) continue;
      const list = pending.get(item.section) ?? [];
      list.push(item);
      pending.set(item.section, list);
      continue;
    }
    const span = ownedSpan(tab, row);
    if (!span) continue;
    const text = formatItem({ ...item, section: row.section });
    applied.add(item.id);
    if (span.rangeText === text) continue;
    groups.push({ index: span.rangeStart, kind: REPLACE, requests: [replaceRange(tabId, row.range_name, text)] });
  }

  for (const [section, items] of pending) {
    // After the section's last item still in the Doc (any state but removed now), else its anchor,
    // else the end of the tab.
    let after: number | null = null;
    let afterItem = false;
    for (const row of rows) {
      if (row.section !== section || !row.range_name || removed.has(row.id)) continue;
      const span = itemSpan(tab, row.range_name);
      if (span && (after === null || span.paraEnd > after)) {
        after = span.paraEnd;
        afterItem = true;
      }
    }
    if (after === null) {
      const anchor = sectionAnchor(meeting, section);
      const span = anchor ? itemSpan(tab, anchor) : null;
      after = span ? span.paraEnd : lastIndex;
    }
    // Insert "\n<line>\n<line>…" just before that paragraph's newline: it is split after its text,
    // which stays as it was.
    const at = after - 1;
    const lines = items.map(formatItem);
    const requests: DocsRequest[] = [
      { insertText: { text: `\n${lines.join("\n")}`, location: { tabId, index: at } } },
    ];
    let offset = at + 1;
    for (let i = 0; i < items.length; i++) {
      requests.push({
        createNamedRange: {
          name: itemRangeName(meeting.id, items[i].id),
          range: { tabId, startIndex: offset, endIndex: offset + lines[i].length },
        },
      });
      applied.add(items[i].id);
      offset += lines[i].length + 1;
    }
    if (!afterItem) {
      // The new paragraphs inherit the heading's style when split off it.
      requests.push({
        updateParagraphStyle: {
          range: { tabId, startIndex: at + 1, endIndex: offset - 1 },
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      });
    }
    groups.push({ index: at, kind: INSERT, requests });
  }

  const head = headerGroup(meeting, tab, headerText);
  if (head.group) groups.push(head.group);
  header = head.header;

  // Highest index first; at the same index a delete runs before an insert.
  groups.sort((a, b) => b.index - a.index || a.kind - b.kind);
  return { requests: groups.flatMap((g) => g.requests), applied, removed, header };
}

/**
 * Note rows after a successful render (what Task 10 persists). Only what the plan actually did
 * changes: applied items get text, owner, due, last_rendered_text and range_name; removed items
 * are dropped; every other row (locked, deleted, skipped) is kept exactly as it was.
 */
export function renderedRows(
  meetingId: string,
  rows: NoteItemRow[],
  desired: NotesItem[],
  plan: Pick<RenderPlan, "applied" | "removed" | "lines">,
): NoteItemRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: NoteItemRow[] = rows.filter((r) => !plan.removed.has(r.id));
  const nextPos = new Map<NoteSection, number>();
  for (const r of rows) nextPos.set(r.section, Math.max(nextPos.get(r.section) ?? -1, r.position));
  for (const item of desired) {
    if (!plan.applied.has(item.id)) continue;
    const row = byId.get(item.id);
    const section = row?.section ?? item.section;
    const updated: NoteItemRow = {
      ...row, // keep the format fields (kind, anchor, done, owner_person_id, carried_from_*, copy_of)
      meeting_id: meetingId,
      id: item.id,
      section,
      text: item.text,
      owner: item.owner ?? null,
      due: item.due ?? null,
      locked: false,
      deleted_by_human: false,
      last_rendered_text: formatItem({ ...item, section }),
      range_name: row?.range_name ?? itemRangeName(meetingId, item.id),
      position: row?.range_name ? row.position : (nextPos.get(section) ?? -1) + 1,
    };
    if (plan.lines) {
      // Format layout: the exact line written, and the item's format fields.
      updated.last_rendered_text = plan.lines.get(item.id) ?? updated.last_rendered_text;
      updated.kind = kindOfSection(section);
      updated.anchor = item.anchor ?? row?.anchor ?? null;
      updated.done = item.done === true;
      updated.copy_of = item.copyOf ?? row?.copy_of ?? null;
    }
    if (!row?.range_name) nextPos.set(section, updated.position);
    const i = out.findIndex((r) => r.id === item.id);
    if (i >= 0) out[i] = updated;
    else out.push(updated);
  }
  return out;
}

export type RenderResult =
  | { status: "ok"; rows: NoteItemRow[]; headerRendered: string | null }
  | { status: "conflict" }
  /** Nothing written and nothing to persist: a format meeting rendered without its planner. */
  | { status: "skipped"; reason: "format-planner-missing" };

let warnedPlannerMissing = false;

/**
 * One batchUpdate guarded by `revisionId` (from readItems) that renders `desired` and, with
 * `headerText`, replaces the header range. 'conflict' when the Doc moved on since that read.
 * On 'ok': `rows` to persist (see renderedRows) and the header line written (persist it as
 * `meetings.header_rendered`), or null when the header was not written.
 */
export async function renderItems(
  auth: OAuth2Client,
  meeting: MeetingRow,
  rows: NoteItemRow[],
  desired: NotesItem[],
  revisionId: string,
  headerText?: string,
  format?: Omit<FormatPlanOpts, "headerText"> & { plan: FormatPlanner },
): Promise<RenderResult> {
  desired = dedupeById(desired);
  // A format meeting rendered by code that does not know formats (e.g. a tick deployed before
  // A12): write nothing rather than v1 lines at the end of a human's Doc.
  if (meeting.layout === "format" && !format) {
    if (!warnedPlannerMissing) {
      warnedPlannerMissing = true;
      console.error(`renderItems: format meeting ${meeting.id} rendered without a format planner; nothing written`);
    }
    return { status: "skipped", reason: "format-planner-missing" };
  }
  const tab =
    snapshots.get(snapshotKey(meeting.doc_id, meeting.notes_tab_id, revisionId)) ??
    (await fetchTab(auth, meeting.doc_id, meeting.notes_tab_id));
  if (tab.revisionId !== revisionId) return { status: "conflict" };
  const plan =
    meeting.layout === "format" && format
      ? format.plan(meeting, tab, rows, desired, {
          profile: format.profile,
          ownerLabel: format.ownerLabel,
          headerText,
          newAnchors: format.newAnchors,
        })
      : planRender(meeting, tab, rows, desired, headerText);
  const ok = (): RenderResult => ({ status: "ok", rows: renderedRows(meeting.id, rows, desired, plan), headerRendered: plan.header });
  if (!plan.requests.length) return ok();
  try {
    await docsApi(auth).documents.batchUpdate({
      documentId: meeting.doc_id,
      requestBody: { requests: plan.requests, writeControl: { requiredRevisionId: revisionId } },
    });
    return ok();
  } catch (err) {
    if (isRevisionConflict(err)) return { status: "conflict" };
    throw err;
  }
}
