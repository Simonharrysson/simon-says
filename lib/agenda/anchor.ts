import type { OAuth2Client } from "google-auth-library";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { paraBullet, paraInTable, paraLine, parseNotesTab, type NotesTab, type Paragraph } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { docsApi, writeWithRevisionGuard, type DocsRequest, type GuardOptions } from "@/lib/google/docs";
import { matchFixedItems } from "./roles";
import { itemAt, normLabel, scanAgenda, type AgendaScan } from "./scan";

// The start-time batch on an agenda Doc (spec "Rendering into a human Doc"): one revision-guarded
// batchUpdate that
// - creates an anchor named range over each agenda item's text (a range changes no text);
// - ranges the tasks and notes headings, appending a missing one at the end of the tab as our own
//   HEADING_2 paragraph;
// - writes the LIVE line (our own range) right after the notes heading, or at the end of the tab
//   when the Doc has no notes section;
// - fills the EMPTY Datum and Tid cells (Tid with a row of its own, so the final pass can write
//   "18:05–19:10"); every non-empty cell, and Sekreterare always, is left alone;
// - ranges the first signature line (Styrelseprotokoll), so the tasks block ends above it.
// Anchoring the same Doc again (a start retry, a Doc used by an earlier meeting) is safe: an
// existing status line of ours is reused, a Tid we wrote ("18:05", "18:05–19:10") is ranged
// again as is, and this meeting's own old ranges are deleted before they are re-created.
// Inserts only ever go before a paragraph's newline or into an empty cell: never inside a human's
// text (pre-flight F6). Requests run from the highest index down, so no index needs adjusting.

export const INITIAL_LIVE_LINE = "Simon Says antecknar live · uppdaterad –";
/** Notes heading appended when the profile has no section at all (the LIVE line needs a home outside the agenda). */
const DEFAULT_NOTES_LABEL = "Anteckningar";

export class AgendaShapeError extends Error {
  readonly code: "no_items";
  constructor(code: "no_items") {
    super(`agenda Doc has no agenda items (${code})`);
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
  /** Rows the server owns from the start: `info-tid` when the Tid cell was empty. */
  rows: NoteItemRow[];
  /** Section labels appended at the end of the tab, in Doc order. */
  appended: string[];
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

/** A Tid value we write: "18:05" at start, "18:05–19:10" after the final pass. */
const OUR_TID = /^\d{2}:\d{2}(–\d{2}:\d{2})?$/;
/** Our status line, as a previous meeting may have left it in the Doc. */
const isStatusText = (line: string) => line.startsWith("Simon Says antecknar live") || line.startsWith("Simon Says · avslutat");

/**
 * Our status line from an earlier anchoring of this Doc: a paragraph under an `ss-*-header` range
 * or starting with our status text, one plain body paragraph outside every agenda item. Null when none.
 */
function statusLine(tab: NotesTab, body: Paragraph[], scan: AgendaScan): Paragraph | null {
  const ok = (p: Paragraph | undefined): p is Paragraph =>
    Boolean(p) && !paraBullet(p!) && isStatusText(paraLine(p!)) && itemAt(scan, p!.start) === null;
  for (const [name, entries] of tab.ranges) {
    if (!/^ss-.+-header$/.test(name)) continue;
    const start = entries.flat()[0]?.start;
    const p = body.find((x) => start !== undefined && start >= x.start && start < x.end);
    if (ok(p)) return p;
  }
  return body.find((p) => ok(p)) ?? null;
}

const BLANK = /^[\s_.…-]*$/;
/** A typed name: one to four capitalised words ("Anna Svensson", "Bo af Klint" is not covered). */
const NAME = /^\p{Lu}[\p{L}'’-]*(\s+\p{Lu}[\p{L}'’-]*){0,3}$/u;

/** "<role>: <blank or name>" or "<role> ____", for one of the profile's signature roles. */
function isSignatureLine(p: Paragraph, roles: string[]): boolean {
  if (paraBullet(p)) return false;
  const line = paraLine(p).trim();
  let label: string;
  let value: string;
  const colon = line.indexOf(":");
  if (colon >= 0) {
    label = line.slice(0, colon);
    value = line.slice(colon + 1).trim();
  } else {
    const m = /^([^_]+?)\s*(_[\s_.…-]*)$/.exec(line);
    if (!m) return false;
    label = m[1];
    value = "";
  }
  const l = normLabel(label);
  // "Ordförande" signs for "Mötesordförande", "Sekreterare" for "Mötessekreterare".
  const isRole = l.length >= 4 && roles.some((r) => r === l || r.endsWith(l));
  return isRole && (BLANK.test(value) || NAME.test(value));
}

/**
 * The first line of the trailing run of signature lines after the agenda: the last run (empty
 * paragraphs allowed inside) that holds at least two such lines or is followed only by empty
 * paragraphs and our status line. A lone "Justerare: Skicka protokollet." never qualifies.
 */
function signatureStart(body: Paragraph[], scan: AgendaScan, profile: FormatProfile): Paragraph | null {
  const roles = (profile.signatures ?? []).map((r) => normLabel(r)).filter(Boolean);
  if (!roles.length) return null;
  const after = scan.items[scan.items.length - 1]?.paraEnd ?? 0;
  const rest = body.filter((p) => p.start >= after);
  const isEmpty = (p: Paragraph) => paraLine(p).trim() === "";
  let found: Paragraph | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (!isSignatureLine(rest[i], roles)) continue;
    let count = 0;
    let j = i;
    while (j < rest.length && (isEmpty(rest[j]) || isSignatureLine(rest[j], roles))) {
      if (!isEmpty(rest[j])) count++;
      j++;
    }
    const trailing = rest.slice(j).every((p) => isEmpty(p) || isStatusText(paraLine(p)));
    if (count >= 2 || trailing) found = rest[i];
    i = j - 1;
  }
  return found;
}

type NewLine = { text: string; style: "HEADING_2" | "NORMAL_TEXT"; name: string };

export function planAnchoring(
  scan: AgendaScan,
  tab: NotesTab,
  opts: { meetingId: string; profile: FormatProfile; startedAt: Date },
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
  const sig = signatureStart(body, scan, profile);
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
  const old = statusLine(tab, body, scan);
  if (old) {
    const end = old.end - 1;
    push(old.start, [
      ...(end > old.start ? [{ deleteContentRange: { range: range(old.start, end) } }] : []),
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

  // Empty Datum / Tid cells (an empty cell is one paragraph holding only its newline).
  const { date, time } = stockholm(opts.startedAt);
  for (const cell of scan.info) {
    const field = normLabel(cell.field);
    if (field !== "datum" && field !== "tid") continue;
    const s = cell.valueCell.paragraphStart;
    const p = tab.paragraphs.find((x) => x.start === s && paraInTable(x));
    if (!p) continue;
    const empty = cell.valueCell.text === "" && p.text === "\n";
    // A Tid we rendered before ("18:05", "18:05–19:10", one paragraph): ours again, ranged as is.
    const earlier = field === "tid" && !empty && OUR_TID.test(cell.valueCell.text) && p.text === `${cell.valueCell.text}\n`;
    if (!empty && !earlier) continue;
    const text = earlier ? cell.valueCell.text : field === "datum" ? date : time;
    const requests: DocsRequest[] = earlier
      ? []
      : [{ insertText: { text, location: { index: s, tabId } } }, plainText(s, s + text.length)];
    if (field === "tid") {
      const name = `ss-${m}-info-tid`;
      requests.push(namedRange(name, s, s + text.length));
      rows.push({
        meeting_id: m,
        id: "info-tid",
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
        anchor: "info.tid",
        done: false,
        copy_of: null,
      });
    }
    push(s, requests);
  }

  ops.sort((a, b) => b.index - a.index || a.order - b.order);
  const requests = ops.flatMap((o) => o.requests);
  // Anchoring again under the same meeting id: a second range with one name would be ambiguous
  // (itemSpan → never written), so this meeting's old ranges go first (ours; no text changes).
  const created = new Set(requests.map((r) => r.createNamedRange?.name).filter((x): x is string => Boolean(x)));
  const stale: DocsRequest[] = [...created]
    .filter((name) => tab.ranges.has(name))
    .map((name) => ({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } }));
  return { requests: [...stale, ...requests], sectionRanges, headerRange, rows, appended };
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
}

/**
 * Read the agenda Doc (first tab when `tabId` is absent), scan it, and write the anchoring batch
 * guarded by the read's revision; on a revision conflict read, scan and write again (up to 4
 * retries with a 150–600 ms wait, as CONFLICT_RETRIES / retryDelayMs). Throws AgendaShapeError
 * ("no_items") before writing anything when the Doc has no agenda items. Roles are matched once,
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
      const scan = scanAgenda(tab, input.profile);
      if (!scan.items.length) throw new AgendaShapeError("no_items");
      const plan = planAnchoring(scan, tab, { meetingId: input.meetingId, profile: input.profile, startedAt: input.startedAt });
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
  };
}
