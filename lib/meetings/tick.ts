import "server-only";
import type { OAuth2Client } from "google-auth-library";
import { logEvent } from "@/lib/db/events";
import type { MeetingRow, MeetingStatus, NoteItemRow } from "@/lib/db/types";
import { closeElSession, dayUsd } from "@/lib/db/usage";
import {
  currentItems,
  diffHumanEdits,
  itemSpan,
  readNotesTab,
  renderItems,
  suggestedItems,
  toNotesItem,
  type NotesTab,
} from "@/lib/docs/notes";
import { appendTranscript, formatTimestamp, type TranscriptLine } from "@/lib/docs/transcript";
import { getEnv } from "@/lib/env";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { retryDelayMs, sleep } from "@/lib/google/docs";
import { defaultMailer, type Mailer } from "@/lib/mail";
import { updateNotes, type UpdateNotesInput, type UpdateNotesResult } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";
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
export const ABANDON_AFTER_SEC = 15 * 60;
/** An `ending` meeting this old was left by a crashed end: the cron finishes it. */
export const STUCK_ENDING_SEC = 10 * 60;
/** How long an end waits for a running tick before ending without the final pass. */
const END_WAIT_MS = 150_000;

export type TickResult = "ok" | "busy" | "doc_paused" | "conflict" | "failed";

/** Everything outside the database a tick talks to; tests replace these. */
export interface TickDeps {
  getAuth(userId: string): Promise<OAuth2Client>;
  readNotes(auth: OAuth2Client, meeting: MeetingRow): Promise<NotesTab>;
  render: typeof renderItems;
  appendTranscript: typeof appendTranscript;
  updateNotes(input: UpdateNotesInput): Promise<UpdateNotesResult>;
  mailer: Mailer;
  now(): Date;
  sleep(ms: number): Promise<void>;
  random(): number;
}

function defaultDeps(): TickDeps {
  return {
    getAuth: getGoogleAuth,
    readNotes: (auth, m) => readNotesTab(auth, m.doc_id, m.notes_tab_id),
    render: renderItems,
    appendTranscript,
    updateNotes: (input) => updateNotes(input),
    mailer: defaultMailer(),
    now: () => new Date(),
    sleep,
    random: Math.random,
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

export const liveHeader = (now: Date) => `● LIVE · uppdaterad ${stockholmTime(now)}`;
export const endedHeader = (endedAt: Date) => `Avslutat ${stockholmTime(endedAt)}`;

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

/**
 * Claude's transcript blocks (one per tick_no, oldest first; lines `[HH:MM:SS] S<n>-<raw>: text`)
 * and the speaker-name map `S<n>-<raw>` → display name for labels that resolve (through merges)
 * to a named speaker. Only segments with a tick_no count.
 */
export function buildTranscript(
  segments: SegmentRead[],
  sessions: SessionRead[],
  speakers: SpeakerRead[],
): { blocks: string[]; speakerNames: Record<string, string> } {
  const r = resolver(sessions, speakers);
  const byTick = new Map<number, string[]>();
  const speakerNames: Record<string, string> = {};
  for (const s of sortSegments(segments, r.numbers)) {
    if (s.tick_no === null) continue;
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
export function readState(tab: NotesTab, rows: NoteItemRow[]): ReadState {
  const kept = retireFrozenNow(tab, rows);
  const diff = diffHumanEdits(kept, currentItems(tab, kept), suggestedItems(tab, kept));
  return {
    revisionId: tab.revisionId,
    text: tab.paragraphs.map((p) => p.text).join(""),
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

async function saveRows(meetingId: string, rows: NoteItemRow[]): Promise<void> {
  if (rows.length) {
    must(
      "tick: save notes",
      await db()
        .from("note_items")
        .upsert(rows.map((r) => ({ ...r, meeting_id: meetingId })), { onConflict: "meeting_id,id" }),
    );
  }
  // Ids are server-made (`n<k>`), safe inside the filter list.
  let del = db().from("note_items").delete().eq("meeting_id", meetingId);
  if (rows.length) del = del.not("id", "in", `(${rows.map((r) => `"${r.id}"`).join(",")})`);
  must("tick: drop notes", await del);
}

async function recordUsage(orgId: string, u: UpdateNotesResult["usage"]): Promise<void> {
  if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.usd) return;
  must(
    "tick: usage",
    await db().rpc("record_claude_usage", {
      p_org_id: orgId,
      p_input: u.input,
      p_output: u.output,
      p_cache_read: u.cacheRead,
      p_cache_write: u.cacheWrite,
      p_usd: u.usd,
    }),
  );
}

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

// ---------------------------------------------------------------------------------------------
// The tick

/**
 * One notes tick under the meeting's lease. `final` (the end pass): no interval floor, Claude
 * may tidy up, header `Avslutat HH:mm` (from ended_at). A non-final tick needs a live meeting
 * and ≥ TICK_FLOOR_SEC since the last attempt, else 'busy' (not run). Claude is skipped under
 * KILL_SWITCH or the daily dollar cap (the Doc still gets the header and the transcript).
 */
export async function runTick(
  meetingId: string,
  opts: { final?: boolean } = {},
  overrides: Partial<TickDeps> = {},
): Promise<TickResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const final = opts.final ?? false;
  const claim = must(
    "tick: lease",
    await db().rpc("claim_tick_lease", { p_meeting_id: meetingId, p_min_interval_secs: final ? 0 : TICK_FLOOR_SEC }),
  ) as string;
  if (claim !== "ok") return "busy";

  let meeting: MeetingRow | null = null;
  let assigned: number | null = null;
  let answered = false;
  try {
    meeting = await loadMeeting(meetingId);
    if (!meeting || (!final && meeting.status !== "live")) return "busy";
    if (!meeting.started_by) throw new GoogleAuthLostError("(deleted user)", "meeting has no starter");
    // Auth first: a lost grant leaves the segments untouched.
    const auth = await deps.getAuth(meeting.started_by);

    assigned = await assignTick(meetingId);
    const ctx = await loadContext(meeting);
    const { blocks, speakerNames } = buildTranscript(ctx.segments, ctx.sessions, ctx.speakers);
    const env = getEnv();
    const claudeAllowed = !env.KILL_SWITCH && (await dayUsd()) < env.GLOBAL_DAILY_USD;
    const sentTick = meeting.notes_sent_tick ?? 0;
    const header = final ? endedHeader(meeting.ended_at ? new Date(meeting.ended_at) : deps.now()) : liveHeader(deps.now());

    // read → diff → Claude
    const first = readState(await deps.readNotes(auth, meeting), ctx.rows);
    let items = first.items;
    let out: UpdateNotesResult | null = null;
    let claudeFailed = false;
    const send = blocksForCall(blocks, sentTick);
    // Claude only with something new to read (or the final pass over a non-empty transcript).
    if (claudeAllowed && send.length > 0 && (final || send.length > sentTick)) {
      out = await deps.updateNotes({
        orgName: ctx.orgName,
        transcriptBlocks: send,
        speakerNames,
        notesTabText: first.text,
        items: first.items,
        locked: first.diff.locked,
        deletedIds: first.diff.deletedIds,
        final,
        nextId: meeting.notes_next_id ?? undefined,
      });
      answered = out.stopReason !== "error";
      claudeFailed = !answered;
      // Spent tokens and handed-out ids count whatever happens to the write.
      await recordUsage(meeting.org_id, out.usage);
      await updateMeeting(meetingId, {
        notes_next_id: out.nextId,
        ...(answered ? { notes_sent_tick: Math.max(sentTick, send.length) } : {}),
      });
      if (answered) items = out.items;
    }

    // read + diff again right before writing; on a revision conflict wait, re-read, retry.
    let notes: "ok" | "conflict" | "skipped" = "skipped";
    if (!claudeFailed) {
      const target: MeetingRow = { ...meeting };
      for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
        if (attempt > 0) await deps.sleep(retryDelayMs(deps.random));
        const st = readState(await deps.readNotes(auth, target), ctx.rows);
        const res = await deps.render(auth, target, st.diff.rows, desiredItems(items, st.diff), st.revisionId, header);
        if (res.status === "ok") {
          await saveRows(meetingId, res.rows);
          if (res.headerRendered !== null) await updateMeeting(meetingId, { header_rendered: res.headerRendered });
          notes = "ok";
          break;
        }
        notes = "conflict";
      }
      if (notes === "conflict") await logEvent(meetingId, "tick_conflict", { tick: assigned, attempts: CONFLICT_RETRIES + 1 });
    }

    // Transcript after the notes write (it bumps the Doc revision).
    if (meeting.transcript_tab_id) {
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

    if (claudeFailed) throw new Error("notes engine request failed");
    if (notes === "conflict") {
      await updateMeeting(meetingId, { doc_paused_at: null });
      return "conflict";
    }
    await updateMeeting(meetingId, { last_tick_ok_at: new Date().toISOString(), failed_ticks: 0, doc_paused_at: null });
    await logEvent(meetingId, "tick_ok", {
      tick: assigned,
      final,
      claude: out !== null,
      ops: out?.ops.length ?? 0,
      dropped: out?.dropped ?? 0,
      stopReason: out?.stopReason ?? null,
      usd: out?.usage.usd ?? 0,
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
    const { error } = await db().from("meetings").update({ tick_lease_until: null }).eq("id", meetingId);
    if (error) console.error(`tick ${meetingId}: lease release: ${error.message}`);
  }
}

/**
 * Tick if one is due (live, not paused, ≥ 45 s since the last, KILL_SWITCH off, daily dollar
 * cap not reached). Never throws: safe inside `after()` in a route.
 */
export async function maybeTick(meetingId: string, overrides: Partial<TickDeps> = {}): Promise<void> {
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
    await runTick(meetingId, { final: false }, overrides);
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

/**
 * Finish a meeting already in `ending`: close its ElevenLabs sessions (books usage), run the
 * final tick (waiting a bounded time for a running one), then set the final status. Always
 * reaches the final status, whatever the tick returns.
 */
export async function finishMeeting(
  meetingId: string,
  finalStatus: Extract<MeetingStatus, "done" | "abandoned">,
  overrides: Partial<TickDeps> = {},
): Promise<TickResult> {
  const deps = { ...defaultDeps(), ...overrides };
  await closeOpenSessions(meetingId);
  let result: TickResult = "busy";
  const start = Date.now();
  for (let tries = 0; ; tries++) {
    try {
      result = await runTick(meetingId, { final: true }, overrides);
    } catch (e) {
      console.error(`end ${meetingId}: final tick: ${errorText(e)}`);
      result = "failed";
    }
    if (result === "busy" && Date.now() - start < END_WAIT_MS) {
      await deps.sleep(2000);
      continue;
    }
    // One more try after a conflict or failure.
    if ((result === "conflict" || result === "failed") && tries === 0) continue;
    break;
  }
  must(
    "end: status",
    await db().from("meetings").update({ status: finalStatus }).eq("id", meetingId).eq("status", "ending"),
  );
  await closeOpenSessions(meetingId);
  await logEvent(meetingId, finalStatus === "done" ? "ended" : "abandoned", { finalTick: result });
  return result;
}

export type EndResult = "ended" | "noop" | "not_found";

/**
 * End a meeting (the end route, the abandon sweep, Task T's test feeder). Atomically live →
 * ending (so ending twice is a no-op and no new tick starts), then finishMeeting.
 */
export async function endMeeting(
  meetingId: string,
  opts: { abandon?: boolean; deps?: Partial<TickDeps> } = {},
): Promise<EndResult> {
  const now = (opts.deps?.now ?? (() => new Date()))();
  const claimed = must(
    "end: claim",
    await db()
      .from("meetings")
      .update({ status: "ending", ended_at: now.toISOString() })
      .eq("id", meetingId)
      .eq("status", "live")
      .select("id"),
  ) as { id: string }[];
  if (!claimed.length) {
    const exists = must("end: read", await db().from("meetings").select("id").eq("id", meetingId).maybeSingle());
    return exists ? "noop" : "not_found";
  }
  await finishMeeting(meetingId, opts.abandon ? "abandoned" : "done", opts.deps);
  return "ended";
}

// ---------------------------------------------------------------------------------------------
// Cron

export interface SweepSummary {
  sessionsClosed: number;
  abandoned: number;
  finished: number;
  resumed: number;
  caughtUp: number;
}

/**
 * The cron (every 5 min): close expired ElevenLabs sessions; abandon live meetings without a heartbeat
 * (or, never having had one, a start) for 15 min; finish meetings stuck in `ending`; resume
 * paused Docs whose owner signed in again; tick live meetings with segments left unticked.
 * `orgId` limits the meeting steps to one org (tests). Stops starting new work after `budgetMs`.
 */
export async function finalizeSweep(
  opts: { deps?: Partial<TickDeps>; orgId?: string; budgetMs?: number } = {},
): Promise<SweepSummary> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const start = Date.now();
  const left = () => Date.now() - start < (opts.budgetMs ?? 200_000);
  const env = getEnv();
  const summary: SweepSummary = { sessionsClosed: 0, abandoned: 0, finished: 0, resumed: 0, caughtUp: 0 };
  const scoped = <T extends { org_id: string }>(rows: T[]) => (opts.orgId ? rows.filter((r) => r.org_id === opts.orgId) : rows);

  summary.sessionsClosed = Number(
    must("sweep: close sessions", await db().rpc("close_expired_el_sessions", { p_usd_per_hour: env.ELEVENLABS_USD_PER_HOUR })) ?? 0,
  );

  const now = deps.now().getTime();
  const live = scoped(
    must(
      "sweep: live",
      await db().from("meetings").select("id, org_id, started_at, last_heartbeat_at, doc_paused_at, status").eq("status", "live"),
    ) as Pick<MeetingRow, "id" | "org_id" | "started_at" | "last_heartbeat_at" | "doc_paused_at" | "status">[],
  );
  const stale = (m: (typeof live)[number]) =>
    now - new Date(m.last_heartbeat_at ?? m.started_at).getTime() > ABANDON_AFTER_SEC * 1000;
  for (const m of live.filter(stale)) {
    if (!left()) break;
    try {
      if ((await endMeeting(m.id, { abandon: true, deps: opts.deps })) === "ended") summary.abandoned++;
    } catch (e) {
      console.error(`sweep: abandon ${m.id}: ${errorText(e)}`);
    }
  }

  const stuck = scoped(
    must(
      "sweep: stuck",
      await db()
        .from("meetings")
        .select("id, org_id")
        .eq("status", "ending")
        .lt("ended_at", new Date(now - STUCK_ENDING_SEC * 1000).toISOString()),
    ) as { id: string; org_id: string }[],
  );
  for (const m of stuck) {
    if (!left()) break;
    try {
      await finishMeeting(m.id, "done", opts.deps);
      summary.finished++;
    } catch (e) {
      console.error(`sweep: finish ${m.id}: ${errorText(e)}`);
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
    if (!left() || !m.started_by) continue;
    try {
      const token = must(
        "sweep: token",
        await db().from("google_tokens").select("updated_at").eq("user_id", m.started_by).maybeSingle(),
      ) as { updated_at: string } | null;
      if (!token || new Date(token.updated_at) <= new Date(m.doc_paused_at!)) continue;
      const result = await runTick(m.id, { final: m.status !== "live" }, opts.deps);
      if (result !== "doc_paused" && result !== "busy") {
        await logEvent(m.id, "resumed", { result });
        summary.resumed++;
      }
    } catch (e) {
      console.error(`sweep: resume ${m.id}: ${errorText(e)}`);
    }
  }

  const pending = must(
    "sweep: untickled",
    await db().from("segments").select("meeting_id").is("tick_no", null).limit(1000),
  ) as { meeting_id: string }[];
  const pendingIds = new Set(pending.map((p) => p.meeting_id));
  for (const m of live) {
    if (!left()) break;
    if (!pendingIds.has(m.id) || stale(m) || m.doc_paused_at) continue;
    await maybeTick(m.id, opts.deps);
    summary.caughtUp++;
  }
  return summary;
}
