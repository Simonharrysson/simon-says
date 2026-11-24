import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MergeIn, SegmentIn } from "./types";

export const MAX_TEXT_CHARS = 2000;
export const MAX_RUNS_PER_MIN = 120;
const MAX_BATCH = 500;

export type IngestErrorCode =
  | "bad_request"
  | "not_found"
  | "meeting_not_live"
  | "session_not_in_meeting"
  | "text_too_long"
  | "rate_limited";

const STATUS: Record<IngestErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  meeting_not_live: 409,
  session_not_in_meeting: 409,
  text_too_long: 413,
  rate_limited: 429,
};

export class IngestError extends Error {
  readonly status: number;
  constructor(readonly code: IngestErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = STATUS[code];
  }
}

const bad = (detail: string) => new IngestError("bad_request", detail);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function validate(segments: unknown, merges: unknown): { segments: SegmentIn[]; merges: MergeIn[] } {
  if (!Array.isArray(segments)) throw bad("segments must be an array");
  if (segments.length > MAX_BATCH) throw bad("too many segments");
  const out: SegmentIn[] = [];
  for (const s of segments as Record<string, unknown>[]) {
    if (!s || typeof s !== "object") throw bad("segment must be an object");
    if (typeof s.text === "string" && s.text.length > MAX_TEXT_CHARS) throw new IngestError("text_too_long");
    if (!isStr(s.elSessionId, 200)) throw bad("elSessionId");
    if (!isInt(s.segmentIndex) || s.segmentIndex > 2_000_000_000) throw bad("segmentIndex");
    if (!isInt(s.runIndex) || s.runIndex > 2_000_000_000) throw bad("runIndex");
    if (!isStr(s.speaker, 100)) throw bad("speaker");
    if (typeof s.text !== "string" || s.text.trim().length === 0) throw bad("text");
    if (!isInt(s.startMs) || !isInt(s.endMs) || s.endMs < s.startMs) throw bad("startMs/endMs");
    if (s.lang !== undefined && s.lang !== null && !isStr(s.lang, 16)) throw bad("lang");
    out.push({
      elSessionId: s.elSessionId,
      segmentIndex: s.segmentIndex,
      runIndex: s.runIndex,
      speaker: s.speaker,
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
      ...(typeof s.lang === "string" ? { lang: s.lang } : {}),
    });
  }
  const ms: MergeIn[] = [];
  if (merges !== undefined && merges !== null) {
    if (!Array.isArray(merges) || merges.length > 100) throw bad("merges");
    for (const m of merges as Record<string, unknown>[]) {
      if (
        !m || !isStr(m.elSessionId, 200) || !isStr(m.into, 100) ||
        !Array.isArray(m.from) || m.from.length === 0 || m.from.length > 50 ||
        !m.from.every((f) => isStr(f, 100))
      ) {
        throw bad("merge");
      }
      ms.push({ elSessionId: m.elSessionId, from: m.from as string[], into: m.into });
    }
  }
  return { segments: out, merges: ms };
}

export interface IngestResult {
  /** Runs in the batch that were new (the rest were already stored). */
  stored: number;
  received: number;
}

/**
 * Store a batch of runs idempotently. ALL validation lives here (the route and the
 * server-side test feeder both call it): shape and sizes, meeting live (done/abandoned → 409),
 * every session belongs to this meeting (closed ones too, so a closed session's last batch is
 * kept), at most 120 runs/min per meeting. A resent key is ignored, never overwritten.
 * Times are converted to meeting-relative ms.
 */
export async function ingestSegments(
  meetingId: string,
  rawSegments: unknown,
  rawMerges?: unknown,
): Promise<IngestResult> {
  const { segments, merges } = validate(rawSegments, rawMerges);
  const db = supabaseAdmin();

  const { data: meeting, error: me } = await db
    .from("meetings")
    .select("id, status, started_at")
    .eq("id", meetingId)
    .maybeSingle();
  if (me) throw new Error(`ingest: meeting: ${me.message}`);
  if (!meeting) throw new IngestError("not_found");
  if (meeting.status === "done" || meeting.status === "abandoned") throw new IngestError("meeting_not_live");

  const sessionIds = [...new Set([...segments.map((s) => s.elSessionId), ...merges.map((m) => m.elSessionId)])];
  const offsets = new Map<string, number>();
  if (sessionIds.length > 0) {
    const { data: sessions, error: se } = await db
      .from("el_sessions")
      .select("id, meeting_id, started_at")
      .in("id", sessionIds);
    if (se) throw new Error(`ingest: sessions: ${se.message}`);
    for (const s of sessions ?? []) {
      if (s.meeting_id === meetingId) {
        offsets.set(s.id, Math.round(new Date(s.started_at).getTime() - new Date(meeting.started_at).getTime()));
      }
    }
    if (sessionIds.some((id) => !offsets.has(id))) throw new IngestError("session_not_in_meeting");
  }

  if (segments.length > 0) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count, error: ce } = await db
      .from("segments")
      .select("*", { count: "exact", head: true })
      .eq("meeting_id", meetingId)
      .gte("created_at", since);
    if (ce) throw new Error(`ingest: rate: ${ce.message}`);
    if ((count ?? 0) + segments.length > MAX_RUNS_PER_MIN) throw new IngestError("rate_limited");
  }

  let stored = 0;
  if (segments.length > 0) {
    const rows = segments.map((s) => {
      const offset = offsets.get(s.elSessionId)!;
      return {
        meeting_id: meetingId,
        el_session_id: s.elSessionId,
        segment_index: s.segmentIndex,
        run_index: s.runIndex,
        speaker: s.speaker,
        text: s.text,
        start_ms: Math.max(0, s.startMs + offset),
        end_ms: Math.max(0, s.endMs + offset),
        lang: s.lang ?? null,
      };
    });
    const { data, error } = await db
      .from("segments")
      .upsert(rows, { onConflict: "el_session_id,segment_index,run_index", ignoreDuplicates: true })
      .select("segment_index");
    if (error) throw new Error(`ingest: insert: ${error.message}`);
    stored = data?.length ?? 0;
  }

  for (const m of merges) await applyMerge(meetingId, m);
  return { stored, received: segments.length };
}

/**
 * `from` labels now mean `into`: their speaker_map rows take the identity of the `into` row
 * (or `into` as display name when it has none yet) and need no confirmation.
 */
async function applyMerge(meetingId: string, m: MergeIn): Promise<void> {
  const db = supabaseAdmin();
  const { data: target, error } = await db
    .from("speaker_map")
    .select("person_id, display_name")
    .eq("meeting_id", meetingId)
    .eq("el_session_id", m.elSessionId)
    .eq("speaker_label", m.into)
    .maybeSingle();
  if (error) throw new Error(`ingest: merge lookup: ${error.message}`);
  const rows = m.from
    .filter((f) => f !== m.into)
    .map((label) => ({
      meeting_id: meetingId,
      el_session_id: m.elSessionId,
      speaker_label: label,
      person_id: target?.person_id ?? null,
      display_name: target?.display_name ?? m.into,
      needs_confirm: false,
    }));
  if (rows.length === 0) return;
  const { error: ue } = await db.from("speaker_map").upsert(rows, { onConflict: "meeting_id,el_session_id,speaker_label" });
  if (ue) throw new Error(`ingest: merge: ${ue.message}`);
}
