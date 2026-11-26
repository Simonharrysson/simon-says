import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { OAuth2Client } from "google-auth-library";
import { propagateDone } from "@/lib/agenda/followup";
import { adoptedAgendaRanges, anchoredStarts, itemAt, newAgendaItems, normLabel, scanAgenda, type AgendaScan } from "@/lib/agenda/scan";
import { saveAgendaLabels } from "@/lib/dashboard/labels";
import { recordClaudeUsage } from "@/lib/db/claude-usage";
import { logEvent } from "@/lib/db/events";
import type { CheckinWindow, ItemRole, MeetingRow, MeetingStatus, NoteItemRow, PersonRow } from "@/lib/db/types";
import { closeElSession, dayUsd } from "@/lib/db/usage";
import { expandCopies, planFormatRender, withoutOwnLines } from "@/lib/docs/format-render";
import {
  currentItems,
  diffHumanEdits,
  itemRangeName,
  itemSpan,
  readNotesTab,
  renderItems,
  suggestedItems,
  toNotesItem,
  type NotesTab,
} from "@/lib/docs/notes";
import type { FormatProfile } from "@/lib/formats/schema";
import { FORMAT_NAMES } from "@/lib/formats/standard";
import { profileFor } from "@/lib/formats/store";
import type { AgendaContext } from "@/lib/notes/agenda-prompt";
import { CHECKIN_MAX_FAILURES, CHECKIN_MAX_MS, CHECKIN_PLACEHOLDER, countCall, detectCheckin, detectorDue, skipTick, maskCheckin, nextWindow, type CheckinFound } from "@/lib/notes/checkin";
import { ownerLabel, resolveOwner } from "@/lib/people/roles";
import { testPeople, usesTestPeople } from "@/lib/testmeeting/fixture";
import { appendTranscript, formatTimestamp, type TranscriptLine } from "@/lib/docs/transcript";
import { getEnv } from "@/lib/env";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { retryDelayMs, sleep } from "@/lib/google/docs";
import { defaultMailer, type Mailer } from "@/lib/mail";
import { updateNotes, type NotesClient, type UpdateNotesInput, type UpdateNotesResult } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";
import { extractNames } from "@/lib/names/extract";
import { pendingNameRounds, runNameRound, type ExtractFn } from "@/lib/names/round";
import { autoEndStatus, lastSeenMs, presence, PRESENCE_GRACE_SEC } from "@/lib/meetings/presence";
import { resolveSpeaker, type SpeakerMapRow } from "@/lib/segments/resolve";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Server-driven notes ticks (Task 10). One tick, under a per-meeting lease:
//   assign tick_no to new segments → read notes tab → diff human edits → Claude (updateNotes)
//   → read + diff again → guarded render with the header (retries on revision conflicts)
//   → append the transcript (a separate write: it bumps the revision) → bookkeeping → event.
// Transcript blocks sent to Claude are built from segments by tick_no with raw speaker labels
// `S<session>-<label>`, so a block's bytes never change once sent; names go in speakerNames.

export const TICK_TARGET_SEC = 45;
export const TICK_FLOOR_SEC = 30;
/** Cache lookback window: never more new transcript blocks in one Claude call. */
export const MAX_NEW_BLOCKS = 20;
export const CONFLICT_RETRIES = 4;
export const ALARM_AFTER_FAILED = 3;
/** Default time an end may take (Ruling 27): a route has maxDuration 300 s. */
export const END_BUDGET_MS = 240_000;
/** End attempts (the end itself + cron retries) before ending without a final pass, with an alarm. */
export const MAX_END_ATTEMPTS = 3;
/** Final passes per end attempt: a second one only for segments that arrived during the first. */
const MAX_FINAL_PASSES = 2;
/** Don't start a final-tick attempt with less time than this before the deadline. */
const MIN_ATTEMPT_MS = 20_000;
/** Don't call Claude with less time than this before the deadline (the pass runs without it). */
const MIN_CLAUDE_MS = 30_000;
/** Claude timeout for a normal tick (the engine's default client: 90 s, 1 retry). */
const CLAUDE_TIMEOUT_MS = 90_000;
/** The cron stops starting work with less time than this left of its budget. */
const SWEEP_MIN_LEFT_MS = 60_000;
/** Name round (Task 11) inside a tick: Claude timeout (measured ≈ 2–3 s), and the time it needs left. */
const NAME_ROUND_TIMEOUT_MS = 30_000;
const NAME_ROUND_MIN_LEFT_MS = 75_000;

/** `not_found`: no such meeting. `busy`: not run (lease held, too soon, or not live for a normal tick). */
export type TickResult = "ok" | "busy" | "doc_paused" | "conflict" | "failed" | "not_found";

/** Everything outside the database a tick talks to; tests replace these. */
export interface TickDeps {
  getAuth(userId: string): Promise<OAuth2Client>;
  readNotes(auth: OAuth2Client, meeting: MeetingRow): Promise<NotesTab>;
  render: typeof renderItems;
  appendTranscript: typeof appendTranscript;
  /** `timeoutMs`: one attempt with that timeout (deadline-bound final passes); else the engine's client. */
  updateNotes(input: UpdateNotesInput, opts?: { timeoutMs?: number }): Promise<UpdateNotesResult>;
  /** The name round's Claude call (lib/names/extract). */
  extractNames: ExtractFn;
  /** The Må-runda detector's Claude call (lib/notes/checkin; format layout only). */
  detectCheckin: typeof detectCheckin;
  mailer: Mailer;
  now(): Date;
  sleep(ms: number): Promise<void>;
  random(): number;
  /** Agenda labels for the org dashboard (0028); best effort, never throws. */
  saveAgendaLabels: typeof saveAgendaLabels;
}

function defaultDeps(): TickDeps {
  return {
    getAuth: getGoogleAuth,
    readNotes: (auth, m) => readNotesTab(auth, m.doc_id, m.notes_tab_id),
    render: renderItems,
    appendTranscript,
    updateNotes: (input, opts) =>
      updateNotes(
        input,
        opts?.timeoutMs
          ? { client: new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY, timeout: opts.timeoutMs, maxRetries: 0 }) as unknown as NotesClient }
          : {},
      ),
    extractNames,
    detectCheckin,
    mailer: defaultMailer(),
    now: () => new Date(),
    sleep,
    random: Math.random,
    saveAgendaLabels,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

/** HH:mm in Europe/Stockholm (the server runs in UTC). */
export function stockholmTime(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** The header line: v1's "LIVE" title line, or the format layout's status line in the notes section. */
export const liveHeader = (now: Date, layout: "v1" | "format" = "v1") =>
  layout === "format" ? `Simon Says antecknar live · uppdaterad ${stockholmTime(now)}` : `LIVE · uppdaterad ${stockholmTime(now)}`;
export const endedHeader = (endedAt: Date, layout: "v1" | "format" = "v1") =>
  layout === "format" ? `Simon Says · avslutat ${stockholmTime(endedAt)}` : `Avslutat ${stockholmTime(endedAt)}`;

/** A normal tick is due once the last one started at least TICK_TARGET_SEC ago. */
export function tickDue(lastTickAt: string | null, now: Date, minSec = TICK_TARGET_SEC): boolean {
  return lastTickAt === null || now.getTime() - new Date(lastTickAt).getTime() >= minSec * 1000;
}

export interface SegmentRead {
  el_session_id: string;
  segment_index: number;
  run_index: number;
  speaker: string;
  text: string;
  start_ms: number;
  tick_no: number | null;
  transcript_written_at: string | null;
}

export interface SessionRead {
  id: string;
  started_at: string;
}

export type SpeakerRead = SpeakerMapRow & { el_session_id: string };

/** Session → 1-based number in start order (stable: sessions only get added later). */
function sessionNumbers(sessions: SessionRead[]): Map<string, number> {
  const sorted = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  return new Map(sorted.map((s, i) => [s.id, i + 1]));
}

function sortSegments(segments: SegmentRead[], numbers: Map<string, number>): SegmentRead[] {
  return [...segments].sort(
    (a, b) =>
      (a.tick_no ?? 0) - (b.tick_no ?? 0) ||
      a.start_ms - b.start_ms ||
      (numbers.get(a.el_session_id) ?? 0) - (numbers.get(b.el_session_id) ?? 0) ||
      a.segment_index - b.segment_index ||
      a.run_index - b.run_index,
  );
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

function resolver(sessions: SessionRead[], speakers: SpeakerRead[]) {
  const numbers = sessionNumbers(sessions);
  const bySession = new Map<string, SpeakerRead[]>();
  for (const s of speakers) bySession.set(s.el_session_id, [...(bySession.get(s.el_session_id) ?? []), s]);
  const label = (sessionId: string, raw: string) => `S${numbers.get(sessionId) ?? 0}-${raw}`;
  const resolve = (sessionId: string, raw: string) => resolveSpeaker(bySession.get(sessionId) ?? [], raw);
  return { numbers, label, resolve };
}

/** Speaker of the Må-runda placeholder line (maskCheckin's). */
const MASK_SPEAKER = "–";
const isPlaceholder = (s: SegmentRead) => s.speaker === MASK_SPEAKER && s.text === CHECKIN_PLACEHOLDER;

/**
 * Sorted segments with the Må-runda window masked (maskCheckin) per tick and per session, so a
 * run never spans two ticks: a tick wholly inside the window still gets its own block (one
 * placeholder line), and a block's bytes depend on its own tick's segments only.
 */
function maskedSegments(sorted: SegmentRead[], window: CheckinWindow, numbers: Map<string, number>): SegmentRead[] {
  const groups = new Map<string, SegmentRead[]>();
  for (const s of sorted) {
    const key = `${s.tick_no}\u0000${s.el_session_id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out = [...groups.values()].flatMap((g) => maskCheckin(g, window, (s) => s.start_ms));
  return sortSegments(out, numbers);
}

/**
 * Claude's transcript blocks (one per tick_no, oldest first; lines `[HH:MM:SS] S<n>-<raw>: text`)
 * and the speaker-name map `S<n>-<raw>` → display name for labels that resolve (through merges)
 * to a named speaker. Only segments with a tick_no count. With a Må-runda `window` (format
 * layout) the segments inside it are masked first: one `[HH:MM:SS] –: [Må-runda — utelämnad]`
 * line per run, per tick and session. Without one the output is exactly v1's.
 */
export function buildTranscript(
  segments: SegmentRead[],
  sessions: SessionRead[],
  speakers: SpeakerRead[],
  window?: CheckinWindow | null,
): { blocks: string[]; speakerNames: Record<string, string> } {
  const r = resolver(sessions, speakers);
  const byTick = new Map<number, string[]>();
  const speakerNames: Record<string, string> = {};
  const sorted = sortSegments(segments, r.numbers);
  for (const s of window ? maskedSegments(sorted, window, r.numbers) : sorted) {
    if (s.tick_no === null) continue;
    if (window && isPlaceholder(s)) {
      const lines = byTick.get(s.tick_no) ?? [];
      lines.push(`[${formatTimestamp(s.start_ms)}] ${MASK_SPEAKER}: ${CHECKIN_PLACEHOLDER}`);
      byTick.set(s.tick_no, lines);
      continue;
    }
    const label = r.label(s.el_session_id, s.speaker);
    const lines = byTick.get(s.tick_no) ?? [];
    lines.push(`[${formatTimestamp(s.start_ms)}] ${label}: ${oneLine(s.text)}`);
    byTick.set(s.tick_no, lines);
    const resolved = r.resolve(s.el_session_id, s.speaker);
    if (resolved.displayName !== resolved.label) speakerNames[label] = resolved.displayName;
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  return { blocks: ticks.map((t) => byTick.get(t)!.join("\n")), speakerNames };
}

/** Doc transcript lines for assigned segments not written yet: display name if known, else `S<n>-<label>`. */
export function transcriptLines(segments: SegmentRead[], sessions: SessionRead[], speakers: SpeakerRead[]): TranscriptLine[] {
  const r = resolver(sessions, speakers);
  return sortSegments(segments, r.numbers)
    .filter((s) => s.tick_no !== null && s.transcript_written_at === null)
    .map((s) => {
      const resolved = r.resolve(s.el_session_id, s.speaker);
      const named = resolved.displayName !== resolved.label;
      return { speaker: named ? resolved.displayName : r.label(s.el_session_id, resolved.label), atMs: s.start_ms, text: s.text };
    });
}

/** The blocks for one Claude call: everything already sent plus at most MAX_NEW_BLOCKS new ones. */
export function blocksForCall(blocks: string[], sentTick: number): string[] {
  return blocks.slice(0, Math.min(blocks.length, Math.max(0, sentTick) + MAX_NEW_BLOCKS));
}

/**
 * Ruling 17: a "now" row whose range no longer covers its whole line (an edge character deleted
 * and retyped lands outside the range) can never be written again. Retire it: drop the row, so
 * its line stays as human text and Claude makes a new "now" item with a new id.
 */
export function retireFrozenNow(tab: NotesTab, rows: NoteItemRow[]): NoteItemRow[] {
  return rows.filter((row) => {
    if (row.section !== "now" || !row.range_name || row.locked || row.deleted_by_human) return true;
    const span = itemSpan(tab, row.range_name);
    return !span || span.rangeText === span.paraText;
  });
}

export interface ReadState {
  revisionId: string;
  /** Full notes-tab text (people's own lines included). */
  text: string;
  diff: ReturnType<typeof diffHumanEdits>;
  /** The service's own current items (not locked, not deleted). */
  items: NotesItem[];
}

/** Diff one read of the notes tab against the stored rows. */
export function readState(tab: NotesTab, rows: NoteItemRow[], opts: { cells?: boolean } = {}): ReadState {
  const kept = retireFrozenNow(tab, rows);
  const diff = diffHumanEdits(kept, currentItems(tab, kept), suggestedItems(tab, kept));
  return {
    revisionId: tab.revisionId,
    // v1 (`cells: false`) reads the body only, as before table cells were parsed (final review R2-M4).
    text: tab.paragraphs
      .filter((p) => opts.cells !== false || !p.inTable)
      .map((p) => p.text)
      .join(""),
    diff,
    items: diff.rows.filter((r) => !r.locked && !r.deleted_by_human).map(toNotesItem),
  };
}

/** What to render: Claude's items minus any a human locked or deleted since, plus the locked ones as they are. */
export function desiredItems(items: NotesItem[], diff: ReadState["diff"]): NotesItem[] {
  const off = new Set([...diff.locked.map((i) => i.id), ...diff.deletedIds]);
  return [...items.filter((i) => !off.has(i.id)), ...diff.locked];
}

// ---------------------------------------------------------------------------------------------
// Format layout (meeting formats A12): pure parts

/** Server rows of the format layout: never Claude's to write. */
export const ATTENDEES_ROW = "info-narvarande";
export const TID_ROW = "info-tid";
export const CHECKIN_DONE_ROW = "checkin-done";
export const CHECKIN_DONE_TEXT = "Må-runda genomförd.";
/** Earlier transcript lines the Må-runda detector gets for context. */
const CHECKIN_CONTEXT_LINES = 20;

/**
 * The Närvarande text: every distinct named speaker (display name, through merges) in
 * first-heard order (earliest segment; ties by name), ", "-joined. Named speakers without a
 * segment come last, by name. "" when nobody is named (the row is then not rendered).
 */
export function attendeesText(speakers: SpeakerRead[], segments: SegmentRead[] = [], sessions: SessionRead[] = []): string {
  const r = resolver(sessions, speakers);
  const first = new Map<string, number>();
  for (const s of segments) {
    if (s.tick_no === null) continue;
    const res = r.resolve(s.el_session_id, s.speaker);
    if (res.displayName === res.label) continue;
    first.set(res.displayName, Math.min(first.get(res.displayName) ?? Infinity, s.start_ms));
  }
  for (const sp of speakers) {
    const res = r.resolve(sp.el_session_id, sp.speaker_label);
    if (res.displayName !== res.label && !first.has(res.displayName)) first.set(res.displayName, Infinity);
  }
  return [...first.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "sv"))
    .map(([name]) => name)
    .join(", ");
}

/** `ag-*` keys of the anchor map that name a range, in numeric order. */
function agendaKeys(ranges: Record<string, unknown>): string[] {
  return Object.keys(ranges)
    .filter((k) => /^ag-\d+$/.test(k) && typeof ranges[k] === "string")
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

/**
 * What the notes engine is told about the agenda Doc this tick (F4). Each stored `ag-*` anchor is
 * found through its named range (`ss-<meeting>-<key>`), and its label and human text come from
 * the scanned item that holds that range's paragraph; an anchor whose range is gone (or no longer
 * in an agenda item) is listed `gone`, without a label. Scan keys are only used for `newItems`
 * (items a human added, role topic). Anchors are in Doc order, gone ones last. `scan` must be of
 * `withoutOwnLines(tab, rows)`, so our own lines are not in the human text.
 */
export function agendaContext(
  tab: NotesTab,
  scan: AgendaScan,
  meeting: Pick<MeetingRow, "id" | "section_ranges" | "agenda_roles">,
  profile: FormatProfile,
  people: Pick<PersonRow, "name" | "role">[],
  newItems: { key: string; start: number }[] = [],
): AgendaContext {
  const ranges = (meeting.section_ranges ?? {}) as Record<string, unknown>;
  const roles = meeting.agenda_roles ?? {};
  const placed: (AgendaContext["anchors"][number] & { at: number })[] = [];
  for (const key of agendaKeys(ranges)) {
    const role: ItemRole = roles[key] ?? "topic";
    const span = itemSpan(tab, (ranges[key] as string | undefined) ?? itemRangeName(meeting.id, key));
    const item = span ? itemAt(scan, span.paraStart) : null;
    placed.push(
      item
        ? { key, label: item.label, role, humanText: item.humanText, at: span!.paraStart }
        : { key, label: "", role, humanText: "", gone: true, at: Infinity },
    );
  }
  for (const n of newItems) {
    const item = itemAt(scan, n.start);
    if (item) placed.push({ key: n.key, label: item.label, role: "topic", humanText: item.humanText, at: n.start });
  }
  placed.sort((a, b) => a.at - b.at || Number(a.key.slice(3)) - Number(b.key.slice(3)));
  return {
    formatName: FORMAT_NAMES[profile.kind],
    decisionPrefix: profile.decisionPrefix,
    groupBy: profile.tasksSection?.groupBy ?? "person",
    numbering: profile.numbering,
    anchors: placed.map(({ at: _at, ...a }) => a),
    people: people.map((p) => ({ name: p.name, role: p.role ?? null })),
  };
}

/**
 * Må-runda text typed in the Doc never reaches the notes engine (final review R2-M2): the checkin
 * item's human text is blanked in the agenda context, and the paragraphs of its blocks after the
 * item line are left out of the notes tab text. Item line and other items unchanged.
 */
export function hideCheckinText(
  tab: NotesTab,
  scan: AgendaScan,
  meeting: Pick<MeetingRow, "section_ranges" | "agenda_roles">,
  agenda: AgendaContext,
): { agenda: AgendaContext; text: string } {
  const all = tab.paragraphs.map((p) => p.text).join("");
  const key = checkinAnchor(meeting);
  if (!key) return { agenda, text: all };
  const span = itemSpan(tab, (meeting.section_ranges as Record<string, string>)[key]);
  const item = span ? itemAt(scan, span.paraStart) : null;
  const blanked = { ...agenda, anchors: agenda.anchors.map((a) => (a.key === key ? { ...a, humanText: "" } : a)) };
  if (!item) return { agenda: blanked, text: all };
  const hidden = item.blocks.map((b, i) => ({ start: i === 0 ? item.paraEnd : b.start, limit: b.limit }));
  const text = tab.paragraphs
    .filter((p) => !hidden.some((h) => p.start >= h.start && p.start < h.limit))
    .map((p) => p.text)
    .join("");
  return { agenda: blanked, text };
}

/** The anchor key of the Må-runda item (role checkin, with a range), or null. */
export function checkinAnchor(meeting: Pick<MeetingRow, "agenda_roles" | "section_ranges">): string | null {
  const ranges = (meeting.section_ranges ?? {}) as Record<string, unknown>;
  return Object.entries(meeting.agenda_roles ?? {}).find(([key, role]) => role === "checkin" && typeof ranges[key] === "string")?.[0] ?? null;
}

/** A row the server writes itself (info cells, Må-runda line) or a tasks-section copy: not Claude's. */
export const isServerItem = (id: string) => id.startsWith("info-") || id === CHECKIN_DONE_ROW || id.endsWith("-t");

/** Claude's share of the items (and of the locked ones): no server rows, no `-t` copies. */
export const claudeItems = (items: NotesItem[]) => items.filter((i) => !isServerItem(i.id) && !i.copyOf);

/**
 * The format layout's render list: Claude's items (minus any locked or deleted since, plus the
 * locked ones, as v1), the server rows not locked or deleted by a human, then the tasks-section
 * copies (expandCopies). Every row we own that should stay must be in it, every tick: the
 * planner removes owned rows that are missing.
 */
export function formatDesired(items: NotesItem[], diff: ReadState["diff"], server: NotesItem[], profile: FormatProfile): NotesItem[] {
  const off = new Set([...diff.locked.map((i) => i.id), ...diff.deletedIds]);
  return expandCopies([...desiredItems(items, diff), ...server.filter((i) => !off.has(i.id))], diff.rows, profile);
}

/**
 * The server rows this tick: Närvarande (when someone is named), the Må-runda line once the
 * window closed after it had started (anchored at the checkin item), and on the final pass the
 * Tid cell "HH:mm–HH:mm" (only when the start wrote it: an `info-tid` row exists).
 */
export function serverItems(input: {
  attendees: string;
  window: CheckinWindow | null;
  checkinKey: string | null;
  tidRow: boolean;
  final: boolean;
  startedAt: Date;
  endedAt: Date;
}): NotesItem[] {
  const out: NotesItem[] = [];
  if (input.attendees) out.push({ id: ATTENDEES_ROW, section: "attendees", text: input.attendees, anchor: "info.narvarande" });
  // Not after a close without an answer (detector failures, or the end pass's over-mask).
  if (input.window?.closed && input.window.startMs !== null && input.window.failures < CHECKIN_MAX_FAILURES && input.checkinKey) {
    out.push({ id: CHECKIN_DONE_ROW, section: "note", text: CHECKIN_DONE_TEXT, anchor: input.checkinKey });
  }
  if (input.final && input.tidRow) {
    out.push({ id: TID_ROW, section: "note", text: `${stockholmTime(input.startedAt)}–${stockholmTime(input.endedAt)}`, anchor: "info.tid" });
  }
  return out;
}

/**
 * New agenda items of a later read keyed as Claude was told: an item with the label of one found
 * in the tick's first read keeps that key; any other gets a key after every key in use.
 *
 * Note: the match is by label only (the indices move between reads). Two new items with one
 * label, or an item renamed between the first read and the render read, can leave Claude's ag-N
 * pointing at no anchor (or the other item): the planner then drops that item for this tick and
 * Claude places it again on the next one (the new anchor is a stored key by then).
 */
export function rekeyNewItems(
  items: { key: string; start: number; end: number }[],
  scan: AgendaScan,
  told: { key: string; label: string }[],
  used: string[],
): { key: string; start: number; end: number }[] {
  const byLabel = new Map(told.map((t) => [normLabel(t.label), t.key]));
  const taken = new Set<string>();
  let max = Math.max(0, ...[...used, ...told.map((t) => t.key)].map((k) => Number(k.slice(3)) || 0));
  return items.map((i) => {
    const label = itemAt(scan, i.start)?.label;
    const known = label !== undefined ? byLabel.get(normLabel(label)) : undefined;
    if (known && !taken.has(known)) {
      taken.add(known);
      return { ...i, key: known };
    }
    return { ...i, key: `ag-${++max}` };
  });
}

/**
 * The span `nextWindow` gets for this tick's segments: their first and last time, with the first
 * raised above every earlier tick's segment, so a window edge never moves into a block already
 * built (a late segment can carry an earlier start_ms than lines already sent).
 */
export function checkinSpan(fresh: SegmentRead[], earlier: SegmentRead[]): { firstMs: number; lastMs: number } {
  const firstNew = Math.min(...fresh.map((s) => s.start_ms));
  const lastMs = Math.max(...fresh.map((s) => s.start_ms));
  const floor = earlier.length ? Math.max(...earlier.map((s) => s.start_ms)) + 1 : -Infinity;
  return { firstMs: Math.max(firstNew, floor), lastMs };
}

/** The tick numbers of the blocks already sent to the notes engine (the first `sentTick` ticks). */
export function sentTicks(segments: SegmentRead[], sentTick: number): Set<number> {
  const ticks = [...new Set(segments.map((s) => s.tick_no).filter((t): t is number => t !== null))].sort((a, b) => a - b);
  return new Set(ticks.slice(0, Math.max(0, sentTick)));
}

/**
 * The window for an end pass while the Må-runda start is still unknown and the detector gave no
 * answer (ruling, fix round 1): mask from the first unsent segment up to the earlier of
 * CHECKIN_MAX_MS after the meeting start and the end of the unsent segments. Over-masking is the
 * safe side. Closed with `failures = CHECKIN_MAX_FAILURES`, so no "Må-runda genomförd." line
 * claims a round nobody confirmed. Nothing left to mask → closed without a window.
 */
export function endPassWindow(prev: CheckinWindow, span: { firstMs: number; lastMs: number }): CheckinWindow {
  const endMs = Math.min(CHECKIN_MAX_MS, span.lastMs + 1);
  const calls = prev.calls !== undefined ? { calls: prev.calls } : {};
  return span.firstMs < endMs
    ? { startMs: span.firstMs, endMs, closed: true, failures: Math.max(prev.failures, CHECKIN_MAX_FAILURES), ...calls }
    : { startMs: null, endMs: null, closed: true, failures: Math.max(prev.failures, CHECKIN_MAX_FAILURES), ...calls };
}

/**
 * R-A6 with a human-edited primary: its tasks copy (`<id>-t`, still ours) keeps updating. Claude
 * gets the copy as an editable item under the primary's id and anchor (its own text, owner, due
 * and done); `proxied` are those primary ids, to be left out of `locked` and `deletedIds`.
 */
export function copyProxies(rows: NoteItemRow[]): { items: NotesItem[]; proxied: Set<string> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: NotesItem[] = [];
  for (const copy of rows) {
    if (!copy.copy_of || copy.locked || copy.deleted_by_human) continue;
    const primary = byId.get(copy.copy_of);
    if (!primary || !(primary.locked || primary.deleted_by_human)) continue;
    const { copyOf: _c, ...base } = toNotesItem(copy);
    items.push({ ...base, id: primary.id, ...(primary.anchor ? { anchor: primary.anchor } : {}) });
  }
  return { items, proxied: new Set(items.map((i) => i.id)) };
}

/** Claude's versions of proxied primaries back as their tasks copies (expandCopies' `given` branch renders them). */
export function unproxy(items: NotesItem[], proxied: Set<string>): NotesItem[] {
  return items.map((i) => (proxied.has(i.id) ? { ...i, id: `${i.id}-t`, anchor: "tasks", copyOf: i.id } : i));
}

// ---------------------------------------------------------------------------------------------
// Database

const db = () => supabaseAdmin();

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

async function loadMeeting(id: string): Promise<MeetingRow | null> {
  return must("tick: meeting", await db().from("meetings").select("*").eq("id", id).maybeSingle()) as MeetingRow | null;
}

async function updateMeeting(id: string, values: Record<string, unknown>): Promise<void> {
  must("tick: update meeting", await db().from("meetings").update(values).eq("id", id));
}

/** updateMeeting only while `leaseId` still holds the tick lease (like saveRows). False: it moved on, nothing written. */
async function updateMeetingLeased(id: string, leaseId: string, values: Record<string, unknown>): Promise<boolean> {
  const rows = must(
    "tick: update meeting (lease)",
    await db().from("meetings").update(values).eq("id", id).eq("tick_lease_id", leaseId).select("id"),
  ) as unknown[];
  return rows.length > 0;
}

/** Give every unassigned segment the next tick_no. Null when there was none. */
async function assignTick(meetingId: string): Promise<number | null> {
  const top = must(
    "tick: max tick",
    await db()
      .from("segments")
      .select("tick_no")
      .eq("meeting_id", meetingId)
      .not("tick_no", "is", null)
      .order("tick_no", { ascending: false })
      .limit(1),
  ) as { tick_no: number }[];
  const next = (top[0]?.tick_no ?? 0) + 1;
  const res = await db()
    .from("segments")
    .update({ tick_no: next }, { count: "exact" })
    .eq("meeting_id", meetingId)
    .is("tick_no", null);
  if (res.error) throw new Error(`tick: assign: ${res.error.message}`);
  return (res.count ?? 0) > 0 ? next : null;
}

async function loadSegments(meetingId: string): Promise<SegmentRead[]> {
  const out: SegmentRead[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = must(
      "tick: segments",
      await db()
        .from("segments")
        .select("el_session_id, segment_index, run_index, speaker, text, start_ms, tick_no, transcript_written_at")
        .eq("meeting_id", meetingId)
        .not("tick_no", "is", null)
        .order("tick_no")
        .order("el_session_id")
        .order("segment_index")
        .order("run_index")
        .range(from, from + page - 1),
    ) as SegmentRead[];
    out.push(...rows.map((r) => ({ ...r, start_ms: Number(r.start_ms) })));
    if (rows.length < page) return out;
  }
}

async function loadContext(meeting: MeetingRow) {
  const [segments, sessions, speakers, rows, org] = await Promise.all([
    loadSegments(meeting.id),
    db().from("el_sessions").select("id, started_at").eq("meeting_id", meeting.id),
    db()
      .from("speaker_map")
      .select("el_session_id, speaker_label, display_name, person_id, merged_into_label")
      .eq("meeting_id", meeting.id),
    db().from("note_items").select("*").eq("meeting_id", meeting.id).order("section").order("position"),
    db().from("orgs").select("name").eq("id", meeting.org_id).maybeSingle(),
  ]);
  return {
    segments,
    sessions: must("tick: sessions", sessions) as SessionRead[],
    speakers: must("tick: speakers", speakers) as SpeakerRead[],
    rows: must("tick: note items", rows) as NoteItemRow[],
    orgName: (must("tick: org", org) as { name: string } | null)?.name ?? "Föreningen",
  };
}

/**
 * Store the tick's note_items (upsert, drop the rest) atomically, only while `leaseId` is still
 * the meeting's tick lease (0020). False: the lease moved on to a newer tick; nothing written.
 */
async function saveRows(meetingId: string, leaseId: string, rows: NoteItemRow[]): Promise<boolean> {
  const saved = must(
    "tick: save notes",
    await db().rpc("save_note_rows", {
      p_meeting_id: meetingId,
      p_lease_id: leaseId,
      p_rows: rows.map(({ meeting_id: _m, ...r }) => r),
    }),
  );
  return saved === true;
}

const recordUsage = recordClaudeUsage;

async function alarmIfNeeded(meeting: MeetingRow, failed: number, deps: TickDeps): Promise<void> {
  if (failed < ALARM_AFTER_FAILED) return;
  const since = new Date(deps.now().getTime() - 3600_000).toISOString();
  const recent = must(
    "tick: alarm check",
    await db().from("meeting_events").select("id").eq("meeting_id", meeting.id).eq("kind", "alarm").gt("at", since).limit(1),
  ) as unknown[];
  if (recent.length) return; // once per meeting per hour
  const subject = `Simon Says: ${failed} misslyckade uppdateringar i rad`;
  const text = `Mötet ${meeting.id} har haft ${failed} misslyckade uppdateringar i rad. Se meeting_events.`;
  let sent = false;
  try {
    sent = await deps.mailer.send({ to: getEnv().ALARM_EMAIL, subject, text });
  } catch (e) {
    console.error(`tick: alarm mail failed: ${(e as Error).message}`);
  }
  await logEvent(meeting.id, "alarm", { failedTicks: failed, sent });
}

const errorText = (e: unknown) => {
  const err = e as Error | undefined;
  return `${err?.name ?? "Error"}: ${String(err?.message ?? e).slice(0, 300)}`;
};

/**
 * Run the name round of every session that has speech and is due (any, on the final pass) and
 * has the time; never throws for a failed round. True while some session's round is still to
 * come (not due yet): the caller holds back the transcript append for this tick.
 */
async function nameRounds(meeting: MeetingRow, deps: TickDeps, final: boolean, deadlineAt?: Date): Promise<boolean> {
  let pending: Awaited<ReturnType<typeof pendingNameRounds>>;
  try {
    pending = await pendingNameRounds(meeting.id, deps.now());
  } catch (e) {
    console.error(`tick ${meeting.id}: name rounds: ${errorText(e)}`);
    return false; // never block the tick (or hold the transcript) over the name round
  }
  let hold = false;
  for (const p of pending) {
    if (!p.due && !final) {
      hold = true;
      continue;
    }
    const left = deadlineAt ? deadlineAt.getTime() - deps.now().getTime() : Infinity;
    if (left < NAME_ROUND_MIN_LEFT_MS) continue;
    await runNameRound(meeting, p.sessionId, {
      extract: deps.extractNames,
      timeoutMs: Math.min(NAME_ROUND_TIMEOUT_MS, left - (NAME_ROUND_MIN_LEFT_MS - NAME_ROUND_TIMEOUT_MS)),
    });
  }
  return hold;
}

/**
 * A format meeting's profile and the org's people (owner labels, owner ids, Claude's people list).
 * An agenda Testmöte uses the fixture's fictional people instead, and never reads people rows
 * (Ruling 38); their ids are not stored (see the save below).
 */
async function loadFormat(meeting: MeetingRow): Promise<{ profile: FormatProfile; people: PersonRow[] }> {
  if (usesTestPeople(meeting)) return { profile: await profileFor(meeting), people: testPeople(meeting.org_id) };
  const [profile, people] = await Promise.all([
    profileFor(meeting),
    db().from("people").select("id, org_id, name, member_user_id, role").eq("org_id", meeting.org_id),
  ]);
  return { profile, people: must("tick: people", people) as PersonRow[] };
}

/**
 * Rows to save with `owner_person_id` resolved from the owner text (people of the org); a carried
 * row keeps the id it was carried with, a row without an owner has none.
 */
export function withOwnerIds(rows: NoteItemRow[], people: PersonRow[]): NoteItemRow[] {
  return rows.map((r) => {
    if (r.carried_from_id != null) return r;
    const id = r.owner ? (resolveOwner(r.owner, people)?.id ?? null) : null;
    return (r.owner_person_id ?? null) === id ? r : { ...r, owner_person_id: id };
  });
}

/**
 * The Må-runda detector for this tick (format layout). While the window is open, one Claude call
 * over every segment not yet sent to the notes engine (20 sent lines as context), then
 * nextWindow; the span's floor is the last SENT segment, so no edge moves into a sent block.
 * Skipped without unsent lines or when `allowed` is false (kill switch, dollar cap, deadline).
 * Schedule (Ruling R-F1): every tick in the first 10 minutes, then every 3rd tick with new lines
 * (skipped ticks hold the lines like an unanswered one, and are no failures); the end pass always.
 * `hold`: the start is still unknown and the detector gave no answer, so the unsent lines must
 * not reach the notes engine yet (they wait for a later tick). The end pass never holds: it
 * masks by `endPassWindow` instead. Usage is recorded here; the window is stored (lease-guarded)
 * when it changed and a `checkin` event (state and times only) logged when it opened or closed.
 * `lost`: the lease moved on, nothing stored.
 */
async function checkinStep(
  meeting: MeetingRow,
  leaseId: string,
  ctx: { segments: SegmentRead[]; sessions: SessionRead[]; speakers: SpeakerRead[] },
  sentTick: number,
  agenda: AgendaContext,
  allowed: boolean,
  final: boolean,
  deps: TickDeps,
): Promise<{ window: CheckinWindow | null; hold: boolean; lost: boolean }> {
  const prev = meeting.checkin_window ?? null;
  if (!prev || prev.closed) return { window: prev, hold: false, lost: false };
  const r = resolver(ctx.sessions, ctx.speakers);
  const sorted = sortSegments(ctx.segments, r.numbers);
  const sent = sentTicks(sorted, sentTick);
  const unsent = sorted.filter((s) => s.tick_no !== null && !sent.has(s.tick_no));
  if (!unsent.length) return { window: prev, hold: false, lost: false };
  const earlier = sorted.filter((s) => s.tick_no !== null && sent.has(s.tick_no));
  const span = checkinSpan(unsent, earlier);
  const line = (s: SegmentRead) => ({ atMs: s.start_ms, speaker: r.label(s.el_session_id, s.speaker), text: s.text });
  let next = prev;
  let answered = false;
  // R-F1: every tick for the first 10 minutes, then every 3rd tick with new lines (the end pass always).
  const due = final || detectorDue(prev, span.lastMs);
  if (allowed && !due) next = skipTick(prev, span);
  if (allowed && due) {
    let found: CheckinFound | "failed" = "failed";
    try {
      const res = await deps.detectCheckin(
        {
          lines: unsent.map(line),
          context: earlier.slice(-CHECKIN_CONTEXT_LINES).map(line),
          agenda: agenda.anchors.filter((a) => !a.gone).map(({ key, label, role }) => ({ key, label, role })),
          window: prev,
        },
        { orgId: meeting.org_id },
      );
      found = res.found;
      if (res.usage) await recordUsage(meeting.org_id, res.usage);
    } catch (e) {
      console.error(`tick ${meeting.id}: checkin: ${errorText(e)}`);
    }
    answered = found !== "failed";
    next = countCall(nextWindow(prev, found, span), prev.calls ?? 0);
  }
  let hold = false;
  if (!answered && !next.closed && next.startMs === null) {
    if (final) next = endPassWindow(next, span);
    else hold = true;
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    if (!(await updateMeetingLeased(meeting.id, leaseId, { checkin_window: next }))) return { window: prev, hold: true, lost: true };
  }
  if (next.closed !== prev.closed || next.startMs !== prev.startMs) {
    await logEvent(meeting.id, "checkin", { state: next.closed ? "closed" : "open", startMs: next.startMs, endMs: next.endMs });
  }
  return { window: next, hold, lost: false };
}

// ---------------------------------------------------------------------------------------------
// The tick

/**
 * One notes tick under the meeting's lease. `final` (the end pass): no interval floor, Claude
 * may tidy up, header `Avslutat HH:mm` (from ended_at). A non-final tick needs a live meeting
 * and ≥ TICK_FLOOR_SEC since the last attempt, else 'busy' (not run). Claude is skipped under
 * KILL_SWITCH or the daily dollar cap (the Doc still gets the header and the transcript), and
 * when less than MIN_CLAUDE_MS is left before `deadlineAt`; with a deadline the Claude call
 * gets one attempt with a timeout that ends before it.
 */
export async function runTick(
  meetingId: string,
  opts: { final?: boolean; deadlineAt?: Date } = {},
  overrides: Partial<TickDeps> = {},
): Promise<TickResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const final = opts.final ?? false;
  const claim = (
    must(
      "tick: lease",
      await db().rpc("claim_tick_lease", { p_meeting_id: meetingId, p_min_interval_secs: final ? 0 : TICK_FLOOR_SEC }),
    ) as { result: string; lease_id: string | null }[]
  )[0];
  if (claim?.result === "not_found") return "not_found";
  if (claim?.result !== "ok" || !claim.lease_id) return "busy";
  const leaseId = claim.lease_id;

  let meeting: MeetingRow | null = null;
  let assigned: number | null = null;
  let answered = false;
  try {
    meeting = await loadMeeting(meetingId);
    if (!meeting) return "not_found";
    if (!final && meeting.status !== "live") return "busy";
    if (!meeting.started_by) throw new GoogleAuthLostError("(deleted user)", "meeting has no starter");
    // Auth first: a lost grant leaves the segments untouched.
    const auth = await deps.getAuth(meeting.started_by);

    assigned = await assignTick(meetingId);
    const env = getEnv();
    const spendOk = !env.KILL_SWITCH && (await dayUsd()) < env.GLOBAL_DAILY_USD;
    // Name rounds first, so this tick's transcript lines and speakerNames already have the names.
    const holdTranscript = spendOk ? await nameRounds(meeting, deps, final, opts.deadlineAt) : false;
    const ctx = await loadContext(meeting);
    const layout = meeting.layout ?? "v1";
    const left = () => (opts.deadlineAt ? opts.deadlineAt.getTime() - deps.now().getTime() : Infinity);

    // Format layout (A12): read the Doc first; the agenda (and the Må-runda window) shape the input.
    let fmt: {
      profile: FormatProfile;
      people: PersonRow[];
      tab: NotesTab;
      agenda: AgendaContext;
      fresh: { key: string; start: number; end: number; label: string }[];
      window: CheckinWindow | null;
      /** The Må-runda start is unknown and the detector gave no answer: no notes call this tick. */
      hold: boolean;
      /** Primaries whose (unlocked) tasks copy Claude edits under the primary's id (R-A6). */
      proxied: Set<string>;
      /** The notes tab text the engine reads: the Må-runda item's lines left out (R2-M2). */
      text: string;
    } | null = null;
    const sentTick = meeting.notes_sent_tick ?? 0;
    if (layout === "format") {
      const { profile, people } = await loadFormat(meeting);
      const tab = await deps.readNotes(auth, meeting);
      // Our ag-* ranges the map lost (a render went through, storing the map did not): adopt them.
      const adopted = adoptedAgendaRanges(tab, meeting.section_ranges ?? {}, meeting.id);
      if (Object.keys(adopted).length) {
        const section_ranges = { ...meeting.section_ranges, ...adopted };
        const agenda_roles = { ...Object.fromEntries(Object.keys(adopted).map((k) => [k, "topic" as const])), ...meeting.agenda_roles };
        if (!(await updateMeetingLeased(meetingId, leaseId, { section_ranges, agenda_roles }))) return "busy";
        meeting.section_ranges = section_ranges;
        meeting.agenda_roles = agenda_roles;
      }
      // Items from the anchors, the mode fixed at the start; the scan only adds new items (R1-I1).
      const scan = scanAgenda(withoutOwnLines(tab, ctx.rows), profile, { anchors: anchoredStarts(tab, meeting.section_ranges ?? {}, meeting.id) });
      const fresh = newAgendaItems(scan, tab, meeting.section_ranges ?? {}, meeting.id).map((n) => ({ ...n, label: itemAt(scan, n.start)?.label ?? "" }));
      // Må-runda text in the Doc stays out of what the notes engine reads (R2-M2).
      const hidden = hideCheckinText(tab, scan, meeting, agendaContext(tab, scan, meeting, profile, people, fresh));
      const agenda = hidden.agenda;
      // The detector runs on the lines not yet sent, within the spend caps and time.
      const detectOk = spendOk && left() >= NAME_ROUND_MIN_LEFT_MS;
      const step = await checkinStep(meeting, leaseId, ctx, sentTick, agenda, detectOk, final, deps);
      if (step.lost) return "busy"; // a newer tick holds the lease: it does this tick's work
      fmt = { profile, people, tab, agenda, fresh, window: step.window, hold: step.hold, proxied: new Set(), text: hidden.text };
    }

    const { blocks, speakerNames } = fmt
      ? buildTranscript(ctx.segments, ctx.sessions, ctx.speakers, fmt.window)
      : buildTranscript(ctx.segments, ctx.sessions, ctx.speakers);
    const timeLeft = left();
    const claudeAllowed = timeLeft >= MIN_CLAUDE_MS && spendOk && !fmt?.hold;
    const header = final
      ? endedHeader(meeting.ended_at ? new Date(meeting.ended_at) : deps.now(), layout)
      : liveHeader(deps.now(), layout);

    // read → diff → Claude
    const first = fmt
      ? { ...readState(fmt.tab, ctx.rows), text: fmt.text }
      : readState(await deps.readNotes(auth, meeting), ctx.rows, { cells: false });
    let items = first.items;
    if (fmt) {
      const proxies = copyProxies(first.diff.rows);
      fmt.proxied = proxies.proxied;
      items = [...claudeItems(first.items), ...proxies.items];
    }
    let out: UpdateNotesResult | null = null;
    let claudeFailed = false;
    const send = blocksForCall(blocks, sentTick);
    // Claude only with something new to read (or the final pass over a non-empty transcript).
    if (claudeAllowed && send.length > 0 && (final || send.length > sentTick)) {
      out = await deps.updateNotes(
        fmt
          ? {
              orgName: ctx.orgName,
              transcriptBlocks: send,
              speakerNames,
              notesTabText: first.text,
              items,
              locked: claudeItems(first.diff.locked).filter((i) => !fmt.proxied.has(i.id)),
              deletedIds: first.diff.deletedIds.filter((id) => !fmt.proxied.has(id)),
              final,
              nextId: meeting.notes_next_id ?? undefined,
              agenda: fmt.agenda,
              // F3: our own lines as rendered ("– " prefix and all) are not human text.
              ownLines: first.diff.rows
                .filter((r) => !r.locked && !r.deleted_by_human && r.last_rendered_text)
                .map((r) => r.last_rendered_text!),
            }
          : {
        orgName: ctx.orgName,
        transcriptBlocks: send,
        speakerNames,
        notesTabText: first.text,
        items: first.items,
        locked: first.diff.locked,
        deletedIds: first.diff.deletedIds,
        final,
        nextId: meeting.notes_next_id ?? undefined,
        },
        Number.isFinite(timeLeft) ? { timeoutMs: Math.min(CLAUDE_TIMEOUT_MS, timeLeft - 20_000) } : undefined,
      );
      // The call came back (even as a refusal, max_tokens or malformed output): its blocks count
      // as sent, so they aren't resent forever. Health-wise any non-answer is a failed tick (B1).
      answered = out.stopReason !== "error";
      claudeFailed = out.failure !== null;
      // Spent tokens and handed-out ids count whatever happens to the write.
      await recordUsage(meeting.org_id, out.usage);
      await updateMeeting(meetingId, {
        notes_next_id: out.nextId,
        ...(answered ? { notes_sent_tick: Math.max(sentTick, send.length) } : {}),
      });
      if (answered) items = out.items;
    }

    // Final pass that had to skip Claude although transcript was unsent (time or spend caps).
    const finalWithoutClaude = final && out === null && send.length > sentTick;

    // read + diff again right before writing; on a revision conflict wait, re-read, retry.
    // After a Claude error only the final pass still writes (unchanged items, `Avslutat` header).
    let notes: "ok" | "conflict" | "skipped" = "skipped";
    let anchorsAdded = 0;
    if (!claudeFailed || final) {
      const target: MeetingRow = { ...meeting };
      // Format layout: the server rows, the same for every attempt.
      const server = fmt
        ? serverItems({
            attendees: attendeesText(ctx.speakers, ctx.segments, ctx.sessions),
            window: fmt.window,
            checkinKey: checkinAnchor(meeting),
            tidRow: ctx.rows.some((r) => r.id === TID_ROW),
            final,
            startedAt: new Date(meeting.started_at),
            endedAt: meeting.ended_at ? new Date(meeting.ended_at) : deps.now(),
          })
        : [];
      for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
        if (attempt > 0) await deps.sleep(retryDelayMs(deps.random));
        const tab = await deps.readNotes(auth, target);
        const st = readState(tab, ctx.rows);
        let newAnchors: { key: string; start: number; end: number }[] = [];
        let newLabels: { key: string; label: string }[] = [];
        let res: Awaited<ReturnType<TickDeps["render"]>>;
        if (fmt) {
          const ranges = meeting.section_ranges ?? {};
          const scan = scanAgenda(withoutOwnLines(tab, st.diff.rows), fmt.profile, { anchors: anchoredStarts(tab, ranges, meetingId) });
          newAnchors = rekeyNewItems(newAgendaItems(scan, tab, ranges, meetingId), scan, fmt.fresh, agendaKeys(ranges));
          newLabels = newAnchors.map((a) => ({ key: a.key, label: itemAt(scan, a.start)?.label ?? "" }));
          const groupBy = fmt.profile.tasksSection?.groupBy ?? "person";
          const people = fmt.people;
          res = await deps.render(auth, target, st.diff.rows, formatDesired(unproxy(items, fmt.proxied), st.diff, server, fmt.profile), st.revisionId, header, {
            plan: planFormatRender,
            profile: fmt.profile,
            ownerLabel: (owner: string) => ownerLabel(resolveOwner(owner, people), owner, groupBy),
            newAnchors,
          });
        } else {
          res = await deps.render(auth, target, st.diff.rows, desiredItems(items, st.diff), st.revisionId, header);
        }
        if (res.status === "ok") {
          let rows = res.rows;
          if (fmt) {
            if (newAnchors.length) {
              // The ranges exist in the Doc now: store them (role topic, F5) under our lease. Lost
              // lease: the newer tick adopts them from the Doc (adoptedAgendaRanges).
              const stored = await updateMeetingLeased(meetingId, leaseId, {
                section_ranges: { ...meeting.section_ranges, ...Object.fromEntries(newAnchors.map((a) => [a.key, itemRangeName(meetingId, a.key)])) },
                agenda_roles: { ...meeting.agenda_roles, ...Object.fromEntries(newAnchors.map((a) => [a.key, "topic"])) },
              });
              if (!stored) {
                console.warn(`tick ${meetingId}: lease ${leaseId} moved on; not saving anchors or notes rows`);
                return "busy";
              }
              anchorsAdded = newAnchors.length;
              if (!meeting.is_test) await deps.saveAgendaLabels(meetingId, meeting.org_id, newLabels);
            }
            // Test people are not people rows: an agenda Testmöte stores no owner ids.
            rows = withOwnerIds(rows, usesTestPeople(meeting) ? [] : fmt.people);
          }
          if (!(await saveRows(meetingId, leaseId, rows))) {
            // A newer tick holds the lease now (ours expired): it owns the rows and the transcript.
            console.warn(`tick ${meetingId}: lease ${leaseId} moved on; not saving notes rows`);
            return "busy";
          }
          if (res.headerRendered !== null) await updateMeeting(meetingId, { header_rendered: res.headerRendered });
          if (fmt) {
            // "Från förra veckan": a carried task done here is done at its source (same org and is_test).
            try {
              await propagateDone(rows, meeting.org_id, meeting.is_test ?? false);
            } catch (e) {
              console.error(`tick ${meetingId}: propagate done: ${errorText(e)}`);
            }
          }
          notes = "ok";
          break;
        }
        if (res.status === "skipped") {
          // Nothing written, nothing saved (rows stay as they were): not a conflict to retry.
          notes = "skipped";
          break;
        }
        notes = "conflict";
      }
      if (notes === "conflict") await logEvent(meetingId, "tick_conflict", { tick: assigned, attempts: CONFLICT_RETRIES + 1 });
    }

    // Transcript after the notes write (it bumps the Doc revision). Held back while a session's
    // name round is still to come, so its first lines are written with names, not labels.
    if (meeting.transcript_tab_id && !holdTranscript) {
      const lines = transcriptLines(ctx.segments, ctx.sessions, ctx.speakers);
      if (lines.length) {
        await deps.appendTranscript(auth, meeting.doc_id, meeting.transcript_tab_id, lines);
        const maxTick = Math.max(...ctx.segments.map((s) => s.tick_no ?? 0));
        must(
          "tick: mark written",
          await db()
            .from("segments")
            .update({ transcript_written_at: new Date().toISOString() })
            .eq("meeting_id", meetingId)
            .is("transcript_written_at", null)
            .not("tick_no", "is", null)
            .lte("tick_no", maxTick),
        );
      }
    }

    if (claudeFailed) {
      throw new Error(out?.failure === "error" ? "notes engine request failed" : `notes engine: no usable answer (${out?.failure})`);
    }
    if (notes === "conflict") {
      await updateMeeting(meetingId, { doc_paused_at: null });
      return "conflict";
    }
    await updateMeeting(meetingId, { last_tick_ok_at: new Date().toISOString(), failed_ticks: 0, doc_paused_at: null });
    await logEvent(meetingId, finalWithoutClaude ? "final_without_claude" : "tick_ok", {
      tick: assigned,
      final,
      claude: out !== null,
      ops: out?.ops.length ?? 0,
      dropped: out?.dropped ?? 0,
      stopReason: out?.stopReason ?? null,
      usd: out?.usage.usd ?? 0,
      ...(fmt ? { anchorsAdded, held: fmt.hold } : {}),
    });
    return "ok";
  } catch (err) {
    if (assigned !== null && !answered) {
      // Never sent to Claude: give the number back, so failed ticks don't pile up blocks.
      await db().from("segments").update({ tick_no: null }).eq("meeting_id", meetingId).eq("tick_no", assigned);
    }
    if (err instanceof GoogleAuthLostError) {
      await updateMeeting(meetingId, { doc_paused_at: new Date().toISOString() });
      await logEvent(meetingId, "doc_paused", { final });
      return "doc_paused";
    }
    console.error(`tick ${meetingId} failed: ${errorText(err)}`);
    const failed = (meeting?.failed_ticks ?? 0) + 1;
    try {
      await updateMeeting(meetingId, { failed_ticks: failed });
      await logEvent(meetingId, "tick_failed", { final, error: errorText(err) });
      if (meeting) await alarmIfNeeded(meeting, failed, deps);
    } catch (e) {
      console.error(`tick ${meetingId}: failure bookkeeping: ${(e as Error).message}`);
    }
    return "failed";
  } finally {
    // Only our own lease: one that expired and was claimed by another tick stays.
    const { error } = await db()
      .from("meetings")
      .update({ tick_lease_until: null, tick_lease_id: null })
      .eq("id", meetingId)
      .eq("tick_lease_id", leaseId);
    if (error) console.error(`tick ${meetingId}: lease release: ${error.message}`);
  }
}

/**
 * Tick if one is due (live, not paused, ≥ 45 s since the last, KILL_SWITCH off, daily dollar
 * cap not reached). Never throws: safe inside `after()` in a route.
 */
export async function maybeTick(
  meetingId: string,
  overrides: Partial<TickDeps> = {},
  opts: { deadlineAt?: Date } = {},
): Promise<void> {
  try {
    const env = getEnv();
    if (env.KILL_SWITCH) return;
    const m = must(
      "maybeTick",
      await db().from("meetings").select("status, last_tick_at, doc_paused_at").eq("id", meetingId).maybeSingle(),
    ) as Pick<MeetingRow, "status" | "last_tick_at" | "doc_paused_at"> | null;
    if (!m || m.status !== "live" || m.doc_paused_at) return;
    if (!tickDue(m.last_tick_at, (overrides.now ?? (() => new Date()))())) return;
    if ((await dayUsd()) >= env.GLOBAL_DAILY_USD) return;
    await runTick(meetingId, { final: false, deadlineAt: opts.deadlineAt }, overrides);
  } catch (e) {
    console.error(`maybeTick ${meetingId}: ${errorText(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ending

async function closeOpenSessions(meetingId: string): Promise<void> {
  const open = must(
    "end: sessions",
    await db().from("el_sessions").select("id").eq("meeting_id", meetingId).is("closed_at", null),
  ) as { id: string }[];
  for (const s of open) await closeElSession(s.id);
}

async function hasUnassigned(meetingId: string): Promise<boolean> {
  const rows = must(
    "end: unassigned",
    await db().from("segments").select("segment_index").eq("meeting_id", meetingId).is("tick_no", null).limit(1),
  ) as unknown[];
  return rows.length > 0;
}

/** `done`: the meeting reached its final status. `pending`: still `ending`, the cron retries. */
export type FinishResult = "done" | "pending" | "locked" | "not_found";

/**
 * One end attempt for a meeting in `ending` (Ruling 27), all before `deadlineAt` (default
 * now + END_BUDGET_MS): close its ElevenLabs sessions (books usage), then final passes —
 * waiting while a running tick holds the lease, a second pass if segments arrived during the
 * first. The status becomes `end_status` only after a final pass returned ok (or doc_paused:
 * the cron's resume writes the final pass once Google works again). Otherwise it stays
 * `ending` and the cron retries; after MAX_END_ATTEMPTS it ends anyway with an alarm.
 * `locked`: another end attempt is running. Never throws once the attempt is claimed.
 */
export async function finishMeeting(
  meetingId: string,
  opts: { deadlineAt?: Date; deps?: Partial<TickDeps> } = {},
): Promise<FinishResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const deadline = opts.deadlineAt ?? new Date(deps.now().getTime() + END_BUDGET_MS);
  const left = () => deadline.getTime() - deps.now().getTime();

  const row = must(
    "end: read",
    await db().from("meetings").select("status, end_status, end_attempts, end_lease_until").eq("id", meetingId).maybeSingle(),
  ) as { status: MeetingStatus; end_status: "done" | "abandoned" | null; end_attempts: number; end_lease_until: string | null } | null;
  if (!row) return "not_found";
  if (row.status !== "ending") return "done";
  if (row.end_lease_until && new Date(row.end_lease_until).getTime() > Date.now()) return "locked";
  // Optimistic claim on the attempt counter: of two concurrent attempts only one matches.
  const attempt = row.end_attempts + 1;
  const claimed = must(
    "end: claim attempt",
    await db()
      .from("meetings")
      .update({ end_attempts: attempt, end_lease_until: new Date(deadline.getTime() + 30_000).toISOString() })
      .eq("id", meetingId)
      .eq("status", "ending")
      .eq("end_attempts", row.end_attempts)
      .select("id"),
  ) as unknown[];
  if (!claimed.length) return "locked";

  const finalStatus = row.end_status ?? "done";
  let result: TickResult = "busy";
  let passes = 0;
  let success = false;
  try {
    await closeOpenSessions(meetingId);
    let failures = 0;
    while (left() > MIN_ATTEMPT_MS) {
      try {
        result = await runTick(meetingId, { final: true, deadlineAt: deadline }, opts.deps);
      } catch (e) {
        console.error(`end ${meetingId}: final tick: ${errorText(e)}`);
        result = "failed";
      }
      if (result === "not_found") return "not_found";
      if (result === "busy") {
        await deps.sleep(2000);
        continue;
      }
      if (result === "ok") {
        passes++;
        if (passes < MAX_FINAL_PASSES && (await hasUnassigned(meetingId))) continue;
        success = true;
        break;
      }
      if (result === "doc_paused") {
        success = true;
        break;
      }
      if (++failures >= 2) break; // conflict / failed twice: let the cron retry later
    }

    if (!success && attempt < MAX_END_ATTEMPTS) {
      console.warn(`end ${meetingId}: attempt ${attempt} without a final pass (${result}); the cron retries`);
      return "pending";
    }
    must(
      "end: status",
      await db().from("meetings").update({ status: finalStatus }).eq("id", meetingId).eq("status", "ending"),
    );
    await closeOpenSessions(meetingId);
    await logEvent(meetingId, finalStatus === "done" ? "ended" : "abandoned", {
      finalTick: result,
      passes,
      attempts: attempt,
      ...(success ? {} : { gaveUp: true }),
    });
    if (!success) {
      let sent = false;
      try {
        sent = await deps.mailer.send({
          to: getEnv().ALARM_EMAIL,
          subject: "Simon Says: mötet avslutades utan slutpass",
          text: `Mötet ${meetingId} avslutades efter ${attempt} försök utan slutpass (${result}).`,
        });
      } catch (e) {
        console.error(`end ${meetingId}: alarm mail failed: ${(e as Error).message}`);
      }
      await logEvent(meetingId, "alarm", { reason: "no_final_pass", attempts: attempt, finalTick: result, sent });
    }
    return "done";
  } catch (e) {
    console.error(`end ${meetingId}: attempt ${attempt}: ${errorText(e)}`);
    return "pending";
  } finally {
    // Only our own attempt's lease: a later attempt (ours ran past it) holds a newer one.
    await db().from("meetings").update({ end_lease_until: null }).eq("id", meetingId).eq("end_attempts", attempt);
  }
}

/** `ending`: the final pass didn't go through yet; the meeting stays `ending` and the cron retries. */
export type EndResult = "ended" | "ending" | "noop" | "not_found";

/**
 * End a meeting (the end route, the abandon sweep, Task T's test feeder). Atomically live →
 * ending (so ending twice is a no-op and no new tick starts), then one finishMeeting attempt
 * within `deadlineAt` (default now + END_BUDGET_MS). Safe inside `after()` in a
 * maxDuration-300 route with the default deadline; only a failing database read throws.
 */
export async function endMeeting(
  meetingId: string,
  opts: { abandon?: boolean; endedAt?: Date; staleBefore?: () => Date; deadlineAt?: Date; deps?: Partial<TickDeps> } = {},
): Promise<EndResult> {
  const claim = await claimEnd(meetingId, opts);
  if (claim !== "claimed") return claim;
  const result = await finishMeeting(meetingId, { deadlineAt: opts.deadlineAt, deps: opts.deps });
  return result === "done" ? "ended" : result === "not_found" ? "not_found" : "ending";
}

/**
 * The first half of endMeeting: atomically live → ending (with ended_at and the target status).
 * "noop" when it was not live (already ending or ended), "not_found" when it doesn't exist.
 * The end route claims at once and runs finishMeeting after the response (R1).
 */
export async function claimEnd(
  meetingId: string,
  opts: { abandon?: boolean; endedAt?: Date; staleBefore?: () => Date; deps?: Partial<TickDeps> } = {},
): Promise<"claimed" | "noop" | "not_found"> {
  // `endedAt`: the presence end stamps when the last tab was heard from, not when the cron ran.
  const now = opts.endedAt ?? (opts.deps?.now ?? (() => new Date()))();
  let query = db()
      .from("meetings")
      .update({
        status: "ending",
        ended_at: now.toISOString(),
        end_status: opts.abandon ? "abandoned" : "done",
        end_attempts: 0,
        end_lease_until: null,
      })
      .eq("id", meetingId)
      .eq("status", "live");
  if (opts.staleBefore) {
    // Presence end: only if still no tab, judged at the claim itself (review I1). A heartbeat
    // that landed after the sweep read its snapshot (a laptop waking up) keeps it live.
    const cutoff = JSON.stringify(opts.staleBefore().toISOString());
    query = query.or(`last_heartbeat_at.lt.${cutoff},and(last_heartbeat_at.is.null,started_at.lt.${cutoff})`);
  }
  const claimed = must("end: claim", await query.select("id")) as { id: string }[];
  if (!claimed.length) {
    const exists = must("end: read", await db().from("meetings").select("id").eq("id", meetingId).maybeSingle());
    return exists ? "noop" : "not_found";
  }
  return "claimed";
}

// ---------------------------------------------------------------------------------------------
// Cron

export interface SweepSummary {
  sessionsClosed: number;
  /** Ended because no tab was connected for PRESENCE_GRACE_SEC (status done, like Avsluta). */
  autoEnded: number;
  /** The same, but nothing was ever said: abandoned (a false start). */
  abandoned: number;
  finished: number;
  resumed: number;
  caughtUp: number;
}

/**
 * The cron (every 5 min): close expired ElevenLabs sessions; retry the end of meetings still
 * `ending` (Ruling 27); end live meetings no tab has been connected to for PRESENCE_GRACE_SEC
 * (lib/meetings/presence.ts): the normal end (final pass, done) when anything was said,
 * abandoned when nothing was; resume paused Docs whose owner signed in again; tick live meetings with
 * segments left unticked. Every step runs within one deadline (`budgetMs`, default 250 s of the
 * route's 300 s) and no new work starts with less than a minute left. `orgId` limits the
 * meeting steps to one org (tests).
 */
export async function finalizeSweep(
  opts: { deps?: Partial<TickDeps>; orgId?: string; budgetMs?: number } = {},
): Promise<SweepSummary> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const deadlineAt = new Date(deps.now().getTime() + (opts.budgetMs ?? 250_000));
  const left = () => deadlineAt.getTime() - deps.now().getTime() > SWEEP_MIN_LEFT_MS;
  const env = getEnv();
  const summary: SweepSummary = { sessionsClosed: 0, autoEnded: 0, abandoned: 0, finished: 0, resumed: 0, caughtUp: 0 };
  const scoped = <T extends { org_id: string }>(rows: T[]) => (opts.orgId ? rows.filter((r) => r.org_id === opts.orgId) : rows);

  try {
    summary.sessionsClosed = Number(
      must("sweep: close sessions", await db().rpc("close_expired_el_sessions", { p_usd_per_hour: env.ELEVENLABS_USD_PER_HOUR })) ?? 0,
    );
  } catch (e) {
    console.error(`sweep: close sessions: ${errorText(e)}`);
  }

  // Ends that did not get their final pass yet (taken before this run abandons more).
  const ending = scoped(
    must("sweep: ending", await db().from("meetings").select("id, org_id").eq("status", "ending")) as {
      id: string;
      org_id: string;
    }[],
  );

  const now = deps.now().getTime();
  const live = scoped(
    must(
      "sweep: live",
      await db().from("meetings").select("id, org_id, started_at, last_heartbeat_at, doc_paused_at, status").eq("status", "live"),
    ) as Pick<MeetingRow, "id" | "org_id" | "started_at" | "last_heartbeat_at" | "doc_paused_at" | "status">[],
  );
  const stale = (m: (typeof live)[number]) => presence(m, now) === "gone";
  for (const m of ending) {
    if (!left()) break;
    try {
      if ((await finishMeeting(m.id, { deadlineAt, deps: opts.deps })) === "done") summary.finished++;
    } catch (e) {
      console.error(`sweep: finish ${m.id}: ${errorText(e)}`);
    }
  }

  for (const m of live.filter(stale)) {
    if (!left()) break;
    try {
      const speech = must(
        "sweep: speech",
        await db().from("segments").select("segment_index").eq("meeting_id", m.id).limit(1),
      ) as unknown[];
      const status = autoEndStatus(speech.length > 0);
      const result = await endMeeting(m.id, {
        abandon: status === "abandoned",
        // done: ended when the last tab was heard from. abandoned: the claim time, so the 2 h
        // "Fortsätt mötet" window and the shown duration are not cut short.
        ...(status === "done" ? { endedAt: new Date(lastSeenMs(m)) } : {}),
        staleBefore: () => new Date(deps.now().getTime() - PRESENCE_GRACE_SEC * 1000),
        deadlineAt,
        deps: opts.deps,
      });
      if (result !== "noop") summary[status === "done" ? "autoEnded" : "abandoned"]++;
    } catch (e) {
      console.error(`sweep: auto end ${m.id}: ${errorText(e)}`);
    }
  }

  if (env.KILL_SWITCH) return summary; // bookkeeping only

  const paused = scoped(
    must(
      "sweep: paused",
      await db().from("meetings").select("id, org_id, started_by, doc_paused_at, status").not("doc_paused_at", "is", null),
    ) as Pick<MeetingRow, "id" | "org_id" | "started_by" | "doc_paused_at" | "status">[],
  );
  for (const m of paused) {
    // `ending` meetings are retried above (their final pass resumes the Doc).
    if (!left() || !m.started_by || m.status === "ending") continue;
    try {
      const token = must(
        "sweep: token",
        await db().from("google_tokens").select("updated_at").eq("user_id", m.started_by).maybeSingle(),
      ) as { updated_at: string } | null;
      if (!token || new Date(token.updated_at) <= new Date(m.doc_paused_at!)) continue;
      const result = await runTick(m.id, { final: m.status !== "live", deadlineAt }, opts.deps);
      if (result !== "doc_paused" && result !== "busy") {
        await logEvent(m.id, "resumed", { result });
        summary.resumed++;
      }
    } catch (e) {
      console.error(`sweep: resume ${m.id}: ${errorText(e)}`);
    }
  }

  // Only live, unpaused, fresh meetings (paused ones keep their segments unassigned by design).
  const candidates = live.filter((m) => !stale(m) && !m.doc_paused_at).map((m) => m.id);
  if (!candidates.length) return summary;
  const pending = must(
    "sweep: unticked",
    await db().from("segments").select("meeting_id").in("meeting_id", candidates).is("tick_no", null).limit(1000),
  ) as { meeting_id: string }[];
  const pendingIds = new Set(pending.map((p) => p.meeting_id));
  for (const m of live) {
    if (!left()) break;
    if (!pendingIds.has(m.id) || !candidates.includes(m.id)) continue;
    await maybeTick(m.id, opts.deps, { deadlineAt });
    summary.caughtUp++;
  }
  return summary;
}
