import type { OAuth2Client } from "google-auth-library";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { paraBullet, paraInTable, paraLine, parseNotesTab, type NotesTab, type Paragraph } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { docsApi, writeWithRevisionGuard, type DocsRequest, type GuardOptions } from "@/lib/google/docs";
import { matchFixedItems } from "./roles";
import { agendaHeadingCount, itemAt, normLabel, scanAgenda, withoutEarlierLines, type AgendaScan } from "./scan";

// The start-time batch on an agenda Doc (spec "Rendering into a human Doc"): one revision-guarded
// batchUpdate that
// - creates an anchor named range over each agenda item's text (a range changes no text);
// - ranges the tasks and notes headings, appending a missing one at the end of the tab as our own
//   HEADING_2 paragraph;
// - writes the LIVE line (our own range) right after the notes heading, or at the end of the tab
//   when the Doc has no notes section;
// - fills the EMPTY Datum and Tid cells, each with a range and a row of its own (the final pass
//   writes Tid "18:05–19:10"); every non-empty cell, and Sekreterare always, is left alone;
// - ranges the first signature line (Styrelseprotokoll), so the tasks block ends above it.
// Anchoring the same Doc again (a start retry, a Doc used by an earlier meeting) is safe: an
// existing status line of ours is reused (only its range's text replaced), a Datum / Tid an
// earlier meeting of ours wrote and no human changed (its range over exactly the cell text, equal
// to that meeting's row) is rewritten with this start, and this meeting's own old ranges are
// deleted before they are re-created.
// Inserts only ever go before a paragraph's newline or into an empty cell: never inside a human's
// text (pre-flight F6). Requests run from the highest index down, so no index needs adjusting.

export const INITIAL_LIVE_LINE = "Simon Says antecknar live · uppdaterad –";
/** Notes heading appended when the profile has no section at all (the LIVE line needs a home outside the agenda). */
const DEFAULT_NOTES_LABEL = "Anteckningar";

export class AgendaShapeError extends Error {
  readonly code: "no_items" | "several_agendas";
  constructor(code: "no_items" | "several_agendas") {
    super(code === "no_items" ? `agenda Doc has no agenda items (${code})` : `agenda Doc has more than one agenda heading (${code})`);
    this.name = "AgendaShapeError";
    this.code = code;
  }
}

export interface AnchorPlan {
  requests: DocsRequest[];
  /** anchor key → named range: `ag-<n>`, `tasks`, `notes`, and `signatures` when found. */
  sectionRanges: Record<string, string>;
  /** The LIVE line's range (store as meetings.header_range). */
  headerRange: string;
  /** Rows the server owns from the start: `info-datum` / `info-tid` for the cells it wrote. */
  rows: NoteItemRow[];
  /** Section labels appended at the end of the tab, in Doc order. */
  appended: string[];
  /**
   * The status line this anchoring took over (parked N5): its text and its range (null: a bare
   * status paragraph, or this meeting's own range). A losing start hands it back (cleanupLosingAnchor).
   */
  replacedStatus: ReplacedStatus | null;
}

export interface ReplacedStatus {
  name: string | null;
  text: string;
}

/** YYYY-MM-DD and HH:mm in Europe/Stockholm. */
function stockholm(at: Date): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Our status line's exact forms, as a previous meeting may have left it in the Doc. */
const STATUS_EXACT = /^Simon Says (antecknar live · uppdaterad (–|\d{2}:\d{2})|· avslutat \d{2}:\d{2})$/;
const isStatusText = (line: string) => line.startsWith("Simon Says antecknar live") || line.startsWith("Simon Says · avslutat");

/** The single part of a named range, or null when it is split or empty. */
function onePart(entries: { start: number; end: number }[][]): { start: number; end: number } | null {
  const parts = entries.flat().filter((x) => x.end > x.start);
  return entries.length === 1 && parts.length === 1 ? parts[0] : null;
}

/**
 * Our status line from an earlier anchoring of this Doc, as the span to replace:
 * - the text of an `ss-*-header` range (a human's text after it in the same paragraph survives);
 * - else a whole paragraph whose text is exactly one of our status forms.
 * Always one plain body paragraph outside every agenda item. Null when none.
 */
function statusSpan(tab: NotesTab, body: Paragraph[], scan: AgendaScan): { start: number; end: number; name: string | null; text: string } | null {
  const plain = (p: Paragraph | undefined): p is Paragraph => Boolean(p) && !paraBullet(p!) && itemAt(scan, p!.start) === null;
  for (const [name, entries] of tab.ranges) {
    if (!/^ss-.+-header$/.test(name)) continue;
    const r = onePart(entries);
    if (!r) continue;
    const p = body.find((x) => r.start >= x.start && r.end <= x.end - 1);
    if (!plain(p)) continue;
    const text = p.text.slice(r.start - p.start, r.end - p.start);
    // Exactly one of our forms: a human who typed inside our range keeps their text (a fresh line is added).
    if (STATUS_EXACT.test(text)) return { ...r, name, text };
  }
  const p = body.find((x) => plain(x) && STATUS_EXACT.test(paraLine(x)));
  return p ? { start: p.start, end: p.end - 1, name: null, text: paraLine(p) } : null;
}

/** A Tid value we write: "18:05" at start, "18:05–19:10" after the final pass; a Datum "2026-11-25". */
const OUR_TID = /^\d{2}:\d{2}(–\d{2}:\d{2})?$/;
const OUR_DATUM = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is the whole text of the Datum / Tid cell paragraph `p` ours to rewrite? Covered exactly by one
 * of our `ss-*-info-<field>` ranges, in a form we write, AND (final review R1-I3) equal to what
 * that meeting last rendered there (`ownInfo`: range name → its row's last_rendered_text, from
 * the DB; rows a human edited are left out). An in-form edit ("18:10" typed over "18:05") is a
 * human's and stays. This meeting's own range (an anchoring retry) is ours when it holds `text`.
 */
function ownInfo(tab: NotesTab, p: Paragraph, field: "tid" | "datum", m: string, text: string, own: Record<string, string>): boolean {
  const end = p.end - 1;
  const line = paraLine(p);
  if (end <= p.start || !(field === "tid" ? OUR_TID : OUR_DATUM).test(line)) return false;
  for (const [name, entries] of tab.ranges) {
    if (!name.startsWith("ss-") || !name.endsWith(`-info-${field}`)) continue;
    const r = onePart(entries);
    if (!r || r.start !== p.start || r.end !== end) continue;
    if (name === `ss-${m}-info-${field}` ? line === text : own[name] === line) return true;
  }
  return false;
}

const BLANK = /^[\s_.…-]*$/;
const PARTICLE = "(?:von|af|de|van|der|la|du|di|da)";
const CAP = "\\p{Lu}[\\p{L}'’-]*";
/** A typed name: first and last name (2–4 capitalised words), lowercase particles between ("Bo af Klint"). */
const NAME = new RegExp(`^${CAP}(?:\\s+(?:${PARTICLE}\\s+)*${CAP}){1,3}$`, "u");

/** "<role>: <blank or name>", "<role> ____" or "<role> <name>", for one of the profile's signature roles. */
function isSignatureLine(p: Paragraph, roles: string[]): boolean {
  if (paraBullet(p)) return false;
  const line = paraLine(p).trim();
  // "Ordförande" signs for "Mötesordförande", "Sekreterare" for "Mötessekreterare".
  const isRole = (label: string) => {
    const l = normLabel(label);
    return l.length >= 4 && roles.some((r) => r === l || r.endsWith(l));
  };
  const colon = line.indexOf(":");
  if (colon >= 0) {
    const value = line.slice(colon + 1).trim();
    return isRole(line.slice(0, colon)) && (BLANK.test(value) || NAME.test(value));
  }
  const blank = /^([^_]+?)\s*(_[\s_.…-]*)$/.exec(line);
  if (blank) return isRole(blank[1]);
  // No colon, filled: a one- or two-word role, then the name.
  const words = line.split(/\s+/);
  for (const k of [1, 2]) {
    if (words.length > k && isRole(words.slice(0, k).join(" ")) && NAME.test(words.slice(k).join(" "))) return true;
  }
  return false;
}

/**
 * The first line of the trailing run of signature lines after the agenda: the last run (empty
 * paragraphs allowed inside) that holds at least two such lines or is followed only by
 * paragraphs that are ours or empty (our status line, our appended headings, anything our ranges
 * cover). A lone "Justerare: Skicka protokollet." never qualifies.
 */
function signatureStart(tab: NotesTab, body: Paragraph[], scan: AgendaScan, profile: FormatProfile): Paragraph | null {
  const roles = (profile.signatures ?? []).map((r) => normLabel(r)).filter(Boolean);
  if (!roles.length) return null;
  const after = scan.items[scan.items.length - 1]?.paraEnd ?? 0;
  const rest = body.filter((p) => p.start >= after);
  const isEmpty = (p: Paragraph) => paraLine(p).trim() === "";
  const ourLabels = new Set(
    [profile.tasksSection?.label, profile.notesSection?.label, DEFAULT_NOTES_LABEL].filter((x): x is string => Boolean(x)).map(normLabel),
  );
  const ourRanges = [...tab.ranges].filter(([name]) => name.startsWith("ss-")).flatMap(([, e]) => e.flat());
  const transparent = (p: Paragraph) =>
    isEmpty(p) ||
    isStatusText(paraLine(p)) ||
    ourLabels.has(normLabel(paraLine(p))) ||
    ourRanges.some((r) => r.end > r.start && r.start >= p.start && r.start < p.end);
  let found: Paragraph | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (!isSignatureLine(rest[i], roles)) continue;
    let count = 0;
    let j = i;
    while (j < rest.length && (isEmpty(rest[j]) || isSignatureLine(rest[j], roles))) {
      if (!isEmpty(rest[j])) count++;
      j++;
    }
    if (count >= 2 || rest.slice(j).every(transparent)) found = rest[i];
    i = j - 1;
  }
  return found;
}

type NewLine = { text: string; style: "HEADING_2" | "NORMAL_TEXT"; name: string };

export function planAnchoring(
  scan: AgendaScan,
  tab: NotesTab,
  opts: {
    meetingId: string;
    profile: FormatProfile;
    startedAt: Date;
    /** Earlier meetings' Datum/Tid rows on this Doc: range name → last_rendered_text (unlocked rows only). */
    ownInfo?: Record<string, string>;
  },
): AnchorPlan {
  const { meetingId: m, profile } = opts;
  const tabId = tab.tabId;
  const range = (startIndex: number, endIndex: number) => ({ tabId, startIndex, endIndex });
  const namedRange = (name: string, start: number, end: number): DocsRequest => ({ createNamedRange: { name, range: range(start, end) } });
  // Inserted text takes the style of the character before it (a bold label, a link): ours is plain.
  const plainText = (start: number, end: number): DocsRequest => ({
    updateTextStyle: {
      range: range(start, end),
      textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
      fields: "bold,italic,underline,strikethrough,link",
    },
  });

  const sectionRanges: Record<string, string> = {};
  const rows: NoteItemRow[] = [];
  const appended: string[] = [];
  // Each op runs at `index`; sorted highest first (ties: in push order).
  const ops: { index: number; order: number; requests: DocsRequest[] }[] = [];
  const push = (index: number, requests: DocsRequest[]) => ops.push({ index, order: ops.length, requests });

  // Agenda items: a range over the item's own paragraph, newline excluded.
  for (const item of scan.items) {
    const name = `ss-${m}-${item.key}`;
    sectionRanges[item.key] = name;
    push(item.paraStart, [namedRange(name, item.paraStart, item.paraEnd - 1)]);
  }

  // Existing section headings.
  const headingRange = (key: string, h: { start: number; end: number }) => {
    const name = `ss-${m}-sec-${key}`;
    sectionRanges[key] = name;
    push(h.start, [namedRange(name, h.start, h.end - 1)]);
  };
  if (scan.tasksHeading) headingRange("tasks", scan.tasksHeading);
  if (scan.notesHeading) headingRange("notes", scan.notesHeading);

  // Signature lines ("Justerare: ____", "Justerare: Anna Svensson", "Ordförande ________"): range
  // the first line of the trailing run of them, so neither the tasks nor the notes block runs into
  // them (format-render's block boundaries include it).
  const body = tab.paragraphs.filter((p) => !paraInTable(p));
  const sig = signatureStart(tab, body, scan, profile);
  if (sig) {
    const name = `ss-${m}-sec-signatures`;
    sectionRanges.signatures = name;
    push(sig.start, [namedRange(name, sig.start, sig.end - 1)]);
  }

  // New paragraphs: grouped by the paragraph they go after, in Doc order.
  const headerRange = `ss-${m}-header`;
  const live: NewLine = { text: INITIAL_LIVE_LINE, style: "NORMAL_TEXT", name: headerRange };
  const groups = new Map<Paragraph, NewLine[]>();
  const add = (after: Paragraph, line: NewLine) => groups.set(after, [...(groups.get(after) ?? []), line]);
  const last = body[body.length - 1];
  // A notes heading inside a table cell is not a body paragraph: the LIVE line then goes at the end.
  const notesPara = scan.notesHeading ? body.find((p) => p.start === scan.notesHeading!.start) : undefined;

  // A status line from an earlier anchoring of this Doc (a start retry, a Doc used again): reuse
  // it (our own text, replaced) rather than adding a second one.
  const old = statusSpan(tab, body, scan);
  if (old) {
    push(old.start, [
      { deleteContentRange: { range: range(old.start, old.end) } },
      { insertText: { text: INITIAL_LIVE_LINE, location: { index: old.start, tabId } } },
      plainText(old.start, old.start + INITIAL_LIVE_LINE.length),
      namedRange(headerRange, old.start, old.start + INITIAL_LIVE_LINE.length),
    ]);
  }
  const liveAt = old ? null : (notesPara ?? last);

  // LIVE at the top of an existing notes section first: when that heading is the tab's last
  // paragraph, the appended headings follow the LIVE line.
  if (liveAt && notesPara) add(notesPara, live);
  if (!scan.tasksHeading && profile.tasksSection) {
    const label = profile.tasksSection.label;
    sectionRanges.tasks = `ss-${m}-sec-tasks`;
    add(last, { text: label, style: "HEADING_2", name: sectionRanges.tasks });
    appended.push(label);
  }
  // A notes heading for a profile with one, and always when no section heading would otherwise
  // end the agenda: the LIVE line must never sit inside the last item's block.
  const needNotes = !scan.notesHeading && (profile.notesSection !== null || (!scan.tasksHeading && !profile.tasksSection));
  if (needNotes) {
    const label = profile.notesSection?.label ?? DEFAULT_NOTES_LABEL;
    sectionRanges.notes = `ss-${m}-sec-notes`;
    add(last, { text: label, style: "HEADING_2", name: sectionRanges.notes });
    appended.push(label);
  }
  if (liveAt && !notesPara) add(last, live);

  for (const [after, lines] of groups) {
    const at = after.end - 1;
    const requests: DocsRequest[] = [{ insertText: { text: `\n${lines.map((l) => l.text).join("\n")}`, location: { index: at, tabId } } }];
    let s = at + 1;
    const spans = lines.map((l) => {
      const span = { line: l, start: s, end: s + l.text.length };
      s = span.end + 1;
      return span;
    });
    const end = spans[spans.length - 1].end;
    // A new paragraph after a list item joins that list (A1 M1): ours are not list items.
    const bulleted = Boolean(paraBullet(after));
    if (bulleted) requests.push({ deleteParagraphBullets: { range: range(at + 1, end) } });
    for (const sp of spans) {
      requests.push({
        updateParagraphStyle: {
          range: range(sp.start, sp.end),
          paragraphStyle: bulleted
            ? { namedStyleType: sp.line.style, indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } }
            : { namedStyleType: sp.line.style },
          fields: bulleted ? "namedStyleType,indentStart,indentFirstLine" : "namedStyleType",
        },
      });
    }
    requests.push(plainText(at + 1, end));
    for (const sp of spans) requests.push(namedRange(sp.line.name, sp.start, sp.end));
    push(at, requests);
  }

  // Empty Datum / Tid cells (an empty cell is one paragraph holding only its newline), or ones an
  // earlier meeting of ours wrote and no human changed since (ownInfo). Each gets a range and a row.
  const { date, time } = stockholm(opts.startedAt);
  for (const cell of scan.info) {
    const field = normLabel(cell.field);
    if (field !== "datum" && field !== "tid") continue;
    const s = cell.valueCell.paragraphStart;
    const p = tab.paragraphs.find((x) => x.start === s && paraInTable(x));
    if (!p) continue;
    const text = field === "datum" ? date : time;
    const empty = cell.valueCell.text === "" && p.text === "\n";
    const earlier = !empty && p.text === `${cell.valueCell.text}\n` && ownInfo(tab, p, field, m, text, opts.ownInfo ?? {});
    if (!empty && !earlier) continue;
    const name = `ss-${m}-info-${field}`;
    push(s, [
      ...(earlier ? [{ deleteContentRange: { range: range(s, p.end - 1) } }] : []),
      { insertText: { text, location: { index: s, tabId } } },
      plainText(s, s + text.length),
      namedRange(name, s, s + text.length),
    ]);
    rows.push({
      meeting_id: m,
      id: `info-${field}`,
      section: "note",
      text,
      owner: null,
      due: null,
      locked: false,
      deleted_by_human: false,
      last_rendered_text: text,
      range_name: name,
      position: 0,
      kind: "note",
      anchor: `info.${field}`,
      done: false,
      copy_of: null,
    });
  }

  ops.sort((a, b) => b.index - a.index || a.order - b.order);
  const requests = ops.flatMap((o) => o.requests);
  // Anchoring again under the same meeting id: a second range with one name would be ambiguous
  // (itemSpan → never written), so this meeting's old ranges go first (ours; no text changes).
  const created = new Set(requests.map((r) => r.createNamedRange?.name).filter((x): x is string => Boolean(x)));
  const stale: DocsRequest[] = [...created]
    .filter((name) => tab.ranges.has(name))
    .map((name) => ({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } }));
  const replacedStatus = old ? { name: old.name && !old.name.startsWith(`ss-${m}-`) ? old.name : null, text: old.text } : null;
  return { requests: [...stale, ...requests], sectionRanges, headerRange, rows, appended, replacedStatus };
}

export interface AnchorResult {
  tabId: string;
  /** The Doc's revision after the anchoring batch. */
  revisionId: string;
  sectionRanges: Record<string, string>;
  headerRange: string;
  headerRendered: string;
  /** `ag-<n>` → role (input.roles, else matchFixedItems on the scanned labels). */
  agendaRoles: Record<string, ItemRole>;
  rows: NoteItemRow[];
  /** The scan of the revision the batch was written against (indices from before the batch). */
  scan: AgendaScan;
  appended: string[];
  /** See AnchorPlan.replacedStatus. */
  replacedStatus: ReplacedStatus | null;
}

/**
 * Read the agenda Doc (first tab when `tabId` is absent), scan it, and write the anchoring batch
 * guarded by the read's revision; on a revision conflict read, scan and write again (up to 4
 * retries with a 150–600 ms wait, as CONFLICT_RETRIES / retryDelayMs). Throws AgendaShapeError
 * before writing anything when the Doc has no agenda items ("no_items") or more than one agenda
 * heading ("several_agendas"). The scan leaves out lines any earlier meeting of ours wrote. Roles are matched once,
 * after the write (one Claude call at most).
 */
export async function anchorAgenda(
  auth: OAuth2Client,
  input: {
    meetingId: string;
    orgId: string;
    docId: string;
    tabId?: string;
    profile: FormatProfile;
    startedAt: Date;
    roles?: Record<string, ItemRole>;
    /** See planAnchoring: earlier meetings' Datum/Tid rows on this Doc. */
    ownInfo?: Record<string, string>;
  },
  guard: GuardOptions = {},
): Promise<AnchorResult> {
  const docs = docsApi(auth);
  const { value } = await writeWithRevisionGuard(
    async () => {
      const doc = (
        await docs.documents.get({ documentId: input.docId, includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" })
      ).data;
      const tabId = input.tabId ?? doc.tabs?.[0]?.tabProperties?.tabId;
      if (!tabId) throw new Error("anchorAgenda: Doc has no tab");
      const tab = parseNotesTab(doc, tabId);
      // One Doc per meeting: several agenda headings (a Doc with many weeks) would anchor the wrong week.
      if (agendaHeadingCount(tab, input.profile) >= 2) throw new AgendaShapeError("several_agendas");
      // Lines an earlier meeting of ours wrote (a Doc used again) never decide what is an item (R1-I1).
      const scan = scanAgenda(withoutEarlierLines(tab), input.profile);
      if (!scan.items.length) throw new AgendaShapeError("no_items");
      const plan = planAnchoring(scan, tab, { meetingId: input.meetingId, profile: input.profile, startedAt: input.startedAt, ownInfo: input.ownInfo });
      return { tab, scan, plan };
    },
    async ({ tab, scan, plan }) => {
      const res = await docs.documents.batchUpdate({
        documentId: input.docId,
        requestBody: { requests: plan.requests, writeControl: { requiredRevisionId: tab.revisionId } },
      });
      return { tab, scan, plan, revisionId: res.data.writeControl?.requiredRevisionId ?? "" };
    },
    guard,
  );
  const { tab, scan, plan, revisionId } = value;
  const agendaRoles =
    input.roles ?? (await matchFixedItems(scan.items, input.profile.fixedAgendaItems, { orgId: input.orgId }));
  return {
    tabId: tab.tabId,
    revisionId,
    sectionRanges: plan.sectionRanges,
    headerRange: plan.headerRange,
    headerRendered: INITIAL_LIVE_LINE,
    agendaRoles,
    rows: plan.rows,
    scan,
    appended: plan.appended,
    replacedStatus: plan.replacedStatus,
  };
}

/**
 * Undo a losing start's anchoring (parked N5: two starts raced on one Doc and the start guard
 * refused this one after it anchored), planned from a fresh read of the tab:
 * - every `ss-<meeting>-*` named range of the loser goes (ranges change no text);
 * - its status line, only while its own header range covers one of our exact status forms (a
 *   human's edit inside it wins: then the text stays):
 *   - if the anchoring took over an earlier status line (`replaced`) whose range is gone (the
 *     winner's, when the winner anchored first: measured, the API drops a range whose text is
 *     deleted), that line's text and range are restored;
 *   - else the line was ours alone: its paragraph goes when it holds nothing else (its text only
 *     when it is the tab's last paragraph or a table follows), else just our text.
 * - Datum / Tid text and appended headings stay (the winner may have ranged them).
 */
export function planLoserCleanup(tab: NotesTab, meetingId: string, replaced: ReplacedStatus | null): DocsRequest[] {
  const tabId = tab.tabId;
  const range = (startIndex: number, endIndex: number) => ({ tabId, startIndex, endIndex });
  const prefix = `ss-${meetingId}-`;
  const live = (name: string) => (tab.ranges.get(name) ?? []).flat().some((x) => x.end > x.start);
  const requests: DocsRequest[] = [...tab.ranges.keys()]
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } }));
  const r = onePart(tab.ranges.get(`${prefix}header`) ?? []);
  if (!r) return requests;
  const body = tab.paragraphs.filter((p) => !paraInTable(p));
  const p = body.find((x) => r.start >= x.start && r.end <= x.end - 1);
  if (!p) return requests;
  const text = p.text.slice(r.start - p.start, r.end - p.start);
  if (!STATUS_EXACT.test(text)) return requests;
  // Another meeting's header range on the same line: the line is theirs too, never removed.
  const shared = [...tab.ranges]
    .filter(([name]) => /^ss-.+-header$/.test(name) && !name.startsWith(prefix))
    .some(([, entries]) => entries.flat().some((x) => x.end > x.start && x.start < p.end && x.end > p.start));
  if (shared) return requests;
  if (replaced && !(replaced.name && live(replaced.name))) {
    requests.push(
      { deleteContentRange: { range: range(r.start, r.end) } },
      { insertText: { text: replaced.text, location: { index: r.start, tabId } } },
      {
        updateTextStyle: {
          range: range(r.start, r.start + replaced.text.length),
          textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
          fields: "bold,italic,underline,strikethrough,link",
        },
      },
    );
    if (replaced.name) requests.push({ createNamedRange: { name: replaced.name, range: range(r.start, r.start + replaced.text.length) } });
    return requests;
  }
  const whole = r.start === p.start && r.end === p.end - 1;
  const last = body[body.length - 1] === p;
  const beforeTable = (tab.tables ?? []).some((t) => t.start === p.end);
  const [s, e] = whole && !last && !beforeTable ? [p.start, p.end] : [r.start, r.end];
  requests.push({ deleteContentRange: { range: range(s, e) } });
  return requests;
}

/**
 * planLoserCleanup on a fresh read, written revision-guarded (a conflict re-reads and re-plans).
 * Returns how many requests went out (0: nothing of the loser's left).
 */
export async function cleanupLosingAnchor(
  auth: OAuth2Client,
  input: { docId: string; tabId: string; meetingId: string; replaced: ReplacedStatus | null },
  guard: GuardOptions = {},
): Promise<number> {
  const docs = docsApi(auth);
  const { value } = await writeWithRevisionGuard(
    async () => {
      const doc = (
        await docs.documents.get({ documentId: input.docId, includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" })
      ).data;
      const tab = parseNotesTab(doc, input.tabId);
      return { tab, requests: planLoserCleanup(tab, input.meetingId, input.replaced) };
    },
    async ({ tab, requests }) => {
      if (!requests.length) return 0;
      await docs.documents.batchUpdate({
        documentId: input.docId,
        requestBody: { requests, writeControl: { requiredRevisionId: tab.revisionId } },
      });
      return requests.length;
    },
    guard,
  );
  return value;
}
