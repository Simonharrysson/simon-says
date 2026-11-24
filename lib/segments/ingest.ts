import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MergeIn, SegmentIn } from "./types";

export const MAX_TEXT_CHARS = 2000;
const MAX_BATCH = 500;

export type IngestErrorCode =
  | "bad_request"
  | "not_found"
  | "meeting_not_live"
  | "session_not_in_meeting"
  | "text_too_long"
  | "rate_limited"
  | "chars_per_min"
  | "chars_total"
  | "unknown_speaker"
  | "merge_cycle";

const STATUS: Record<IngestErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  meeting_not_live: 409,
  session_not_in_meeting: 409,
  text_too_long: 413,
  rate_limited: 429,
  chars_per_min: 429,
  chars_total: 413,
  unknown_speaker: 400,
  merge_cycle: 400,
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

/** Slack on top of a session's max_seconds for session-relative times. */
const TIME_SLACK_MS = 60_000;

/**
 * Store a batch of runs idempotently. ALL validation lives here (the route and the
 * server-side test feeder both call it): shape and sizes, meeting live (done/abandoned → 409),
 * every session belongs to this meeting (closed ones too, so a closed session's last batch is
 * kept), times within the session's length. The caps (120 runs/min incl. merged labels,
 * 20 000 chars/min, 600 000 chars per meeting) are checked together with the insert in one
 * SQL function under a per-meeting lock (ingest_segments), counting only keys not stored yet.
 * A resent key is ignored, never overwritten. Times are converted to meeting-relative ms.
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
  const info = new Map<string, { offset: number; maxMs: number }>();
  if (sessionIds.length > 0) {
    const { data: sessions, error: se } = await db
      .from("el_sessions")
      .select("id, meeting_id, started_at, max_seconds")
      .in("id", sessionIds);
    if (se) throw new Error(`ingest: sessions: ${se.message}`);
    for (const s of sessions ?? []) {
      if (s.meeting_id === meetingId) {
        info.set(s.id, {
          offset: Math.round(new Date(s.started_at).getTime() - new Date(meeting.started_at).getTime()),
          maxMs: s.max_seconds * 1000 + TIME_SLACK_MS,
        });
      }
    }
    if (sessionIds.some((id) => !info.has(id))) throw new IngestError("session_not_in_meeting");
  }
  for (const s of segments) {
    if (s.endMs > info.get(s.elSessionId)!.maxMs) throw bad("time beyond session length");
  }

  const rows = segments.map((s) => {
    const { offset } = info.get(s.elSessionId)!;
    return {
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
  const { data, error } = await db.rpc("ingest_segments", {
    p_meeting_id: meetingId,
    p_rows: rows,
    p_merges: merges.map((m) => ({ el_session_id: m.elSessionId, from: [...new Set(m.from)], into: m.into })),
  });
  if (error) throw new Error(`ingest: ${error.message}`);
  const res = data as { status: string; stored?: number };
  if (res.status !== "ok") throw new IngestError(res.status as IngestErrorCode);
  return { stored: res.stored ?? 0, received: segments.length };
}
