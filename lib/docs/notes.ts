import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import type { MeetingRow, NoteItemRow, NoteSection } from "@/lib/db/types";
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

/** Replaces any embedded object (chip, image, …) in paragraph text, so such edits never compare equal. */
const OBJECT = "￼";

export const itemRangeName = (meetingId: string, itemId: string) => `ss-${meetingId}-${itemId}`;

function clean(s: string): string {
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
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the notes tab

interface Paragraph {
  start: number;
  end: number;
  /** Text including the trailing "\n"; non-text elements appear as OBJECT. */
  text: string;
  /** Holds a pending suggestion (suggested insertion, deletion or style change) by a human. */
  suggested: boolean;
}

export interface NotesTab {
  revisionId: string;
  tabId: string;
  paragraphs: Paragraph[];
  /** name → one entry per named range with that name → its parts. */
  ranges: Map<string, { start: number; end: number }[][]>;
}

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

/** Paragraphs and named ranges of one tab, from `documents.get` with includeTabsContent=true. */
export function parseNotesTab(doc: docs_v1.Schema$Document, tabId: string): NotesTab {
  const tab = findTab(doc.tabs, tabId);
  if (!tab?.documentTab) throw new Error(`tab ${tabId} not found (was includeTabsContent set?)`);
  const paragraphs: Paragraph[] = [];
  for (const el of tab.documentTab.body?.content ?? []) {
    if (!el.paragraph || el.startIndex == null || el.endIndex == null) continue;
    let text = "";
    let suggested = hasSuggestion(el.paragraph);
    for (const pe of el.paragraph.elements ?? []) {
      if (pe.textRun?.content != null) text += pe.textRun.content;
      else text += OBJECT.repeat(Math.max(1, (pe.endIndex ?? 0) - (pe.startIndex ?? 0)));
      const inner = pe.textRun ?? pe.inlineObjectElement ?? pe.autoText ?? pe.pageBreak ?? pe.footnoteReference ??
        pe.horizontalRule ?? pe.equation ?? pe.person ?? pe.richLink ?? pe.columnBreak ?? null;
      if (inner && hasSuggestion(inner)) suggested = true;
    }
    paragraphs.push({ start: el.startIndex, end: el.endIndex, text, suggested });
  }
  const ranges = new Map<string, { start: number; end: number }[][]>();
  for (const [name, group] of Object.entries(tab.documentTab.namedRanges ?? {})) {
    const entries = (group.namedRanges ?? []).map((nr) =>
      (nr.ranges ?? []).map((r) => ({ start: r.startIndex ?? 0, end: r.endIndex ?? 0 })),
    );
    if (entries.length) ranges.set(name, entries);
  }
  return { revisionId: doc.revisionId ?? "", tabId, paragraphs, ranges };
}

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
  const touched = tab.paragraphs.filter((p) => p.start < rangeEnd && p.end > rangeStart);
  if (!touched.length) return null;
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

type Group = { index: number; kind: 0 | 1 | 2; requests: DocsRequest[] };
const DELETE = 0;
const INSERT = 1;
const REPLACE = 2;

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
function ownedSpan(tab: NotesTab, row: NoteItemRow): ItemSpan | null {
  if (!row.range_name || row.locked || row.deleted_by_human) return null;
  const span = itemSpan(tab, row.range_name);
  if (!span || span.ambiguous || span.suggested || span.rangeText !== span.paraText) return null;
  if (row.section !== "now" && span.paraText !== row.last_rendered_text) return null;
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
}

/** An item we refuse to render: nothing visible left after cleaning. */
const isEmptyItem = (item: NotesItem) => clean(item.text) === "";

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
  const lastIndex = tab.paragraphs.length ? tab.paragraphs[tab.paragraphs.length - 1].end : 1;
  const doomed: { start: number; end: number; name: string }[] = [];
  for (const row of rows) {
    if (desiredIds.has(row.id)) continue;
    const span = ownedSpan(tab, row);
    // Only remove a paragraph that holds nothing but our line.
    if (!span || span.paraText !== row.last_rendered_text) continue;
    removed.add(row.id);
    doomed.push({ start: span.paraStart, end: span.paraEnd, name: row.range_name! });
  }
  // Adjacent removed paragraphs become one run, so deletes never overlap.
  doomed.sort((a, b) => a.start - b.start);
  const runs: { start: number; end: number; names: string[] }[] = [];
  for (const d of doomed) {
    const run = runs.at(-1);
    if (run && d.start <= run.end) {
      run.end = Math.max(run.end, d.end);
      run.names.push(d.name);
    } else runs.push({ start: d.start, end: d.end, names: [d.name] });
  }
  for (const run of runs) {
    // The tab's final newline cannot be deleted: a run reaching the end takes the newline before it.
    const isLast = run.end >= lastIndex;
    const start = isLast ? Math.max(1, run.start - 1) : run.start;
    const end = isLast ? lastIndex - 1 : run.end;
    const requests: DocsRequest[] = run.names.map((name) => ({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } }));
    if (end > start) requests.push({ deleteContentRange: { range: { tabId, startIndex: start, endIndex: end } } });
    groups.push({ index: start, kind: DELETE, requests });
  }

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

  if (headerText !== undefined && meeting.header_range) {
    const span = itemSpan(tab, meeting.header_range);
    const text = clean(headerText);
    // Ours only while the range is the whole single paragraph and still the line we last wrote
    // (null = not recorded yet: the coverage check alone).
    const owned =
      span &&
      !span.ambiguous &&
      !span.suggested &&
      span.rangeText === span.paraText &&
      !span.paraText.includes("\n") &&
      (meeting.header_rendered == null || span.paraText === meeting.header_rendered);
    if (owned && text !== "" && span.rangeText !== text) {
      groups.push({ index: span.rangeStart, kind: REPLACE, requests: [replaceRange(tabId, meeting.header_range, text)] });
      header = text;
    }
  }

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
  plan: Pick<RenderPlan, "applied" | "removed">,
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
    if (!row?.range_name) nextPos.set(section, updated.position);
    const i = out.findIndex((r) => r.id === item.id);
    if (i >= 0) out[i] = updated;
    else out.push(updated);
  }
  return out;
}

export type RenderResult =
  | { status: "ok"; rows: NoteItemRow[]; headerRendered: string | null }
  | { status: "conflict" };

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
): Promise<RenderResult> {
  const tab =
    snapshots.get(snapshotKey(meeting.doc_id, meeting.notes_tab_id, revisionId)) ??
    (await fetchTab(auth, meeting.doc_id, meeting.notes_tab_id));
  if (tab.revisionId !== revisionId) return { status: "conflict" };
  const plan = planRender(meeting, tab, rows, desired, headerText);
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
