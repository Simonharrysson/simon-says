// ElevenLabs realtime Scribe events → our model. PROVISIONAL: written from the plan's event
// model and the spike's analyzer (spike/analyze.mjs) before any real session could be recorded
// (credits return 2026-11-28). Every assumption is listed under "Verify on 11-28" in
// docs/learnings.md. Pure; used in the browser (LiveStream) and in tests.
import type { Run } from "@/lib/segments/types";

export interface DiarizedWord {
  text: string;
  /** null when ElevenLabs gave no speaker for the word. Spacing tokens have none. */
  speaker: string | null;
  startMs: number;
  endMs: number;
  /** "spacing" tokens carry the whitespace between words. */
  spacing?: boolean;
}

export interface DiarizedEvent {
  kind: "diarized";
  segmentIndex: number;
  words: DiarizedWord[];
  lang?: string;
}

export type ParsedEvent =
  | { kind: "started"; sessionId: string | null }
  | { kind: "partial"; text: string }
  /** startMs/endMs only when the event carries word timestamps (…_with_timestamps). */
  | { kind: "committed"; segmentIndex: number; text: string; lang?: string; startMs?: number; endMs?: number }
  | DiarizedEvent
  | { kind: "merged"; from: string[]; into: string }
  | { kind: "session_end"; reason: string }
  | { kind: "error"; code: string; message?: string }
  /** Valid JSON we don't use (e.g. speaker_names) or not JSON at all. */
  | { kind: "ignored"; type: string };

/** Messages that mean the session is over; the socket closes after them. */
const SESSION_END = new Set(["session_time_limit_exceeded", "session_ended", "session_closed"]);

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const secToMs = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : 0);
const index = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

function words(raw: unknown): DiarizedWord[] {
  if (!Array.isArray(raw)) return [];
  const out: DiarizedWord[] = [];
  for (const w of raw as Raw[]) {
    if (!w || typeof w !== "object" || typeof w.text !== "string") continue;
    const spacing = w.type === "spacing";
    const speaker = str(w.speaker_id) ?? str(w.speaker) ?? null;
    out.push({ text: w.text, speaker: spacing ? null : speaker, startMs: secToMs(w.start), endMs: secToMs(w.end), ...(spacing ? { spacing } : {}) });
  }
  return out;
}

/** One WebSocket message (a JSON string) → a ParsedEvent. Never throws. */
export function parseEvent(raw: string): ParsedEvent {
  let m: Raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "ignored", type: "not_an_object" };
    m = parsed as Raw;
  } catch {
    return { kind: "ignored", type: "not_json" };
  }
  const type = str(m.message_type) ?? "unknown";
  const lang = str(m.language_code);

  switch (type) {
    case "session_started":
      return { kind: "started", sessionId: str(m.session_id) ?? null };
    case "partial_transcript":
      return { kind: "partial", text: str(m.text) ?? "" };
    case "committed_transcript":
    case "committed_transcript_with_timestamps": {
      const segmentIndex = index(m.segment_index);
      if (segmentIndex === null) return { kind: "ignored", type };
      const timed = words(m.words).filter((w) => !w.spacing);
      const times = timed.length
        ? { startMs: timed[0].startMs, endMs: Math.max(timed[0].startMs, ...timed.map((w) => w.endMs)) }
        : {};
      return { kind: "committed", segmentIndex, text: str(m.text) ?? "", ...(lang ? { lang } : {}), ...times };
    }
    case "diarized_transcript": {
      const segmentIndex = index(m.segment_index);
      if (segmentIndex === null) return { kind: "ignored", type };
      return { kind: "diarized", segmentIndex, words: words(m.words), ...(lang ? { lang } : {}) };
    }
    case "speakers_merged": {
      // The spike's analyzer reads from_speaker_id/to_speaker_id; accept a list too.
      const from = Array.isArray(m.from_speaker_ids)
        ? (m.from_speaker_ids as unknown[]).filter((x): x is string => typeof x === "string" && x !== "")
        : str(m.from_speaker_id)
          ? [m.from_speaker_id as string]
          : [];
      const into = str(m.to_speaker_id) ?? str(m.into_speaker_id) ?? "";
      if (!from.length || !into) return { kind: "ignored", type };
      return { kind: "merged", from, into };
    }
  }
  if (SESSION_END.has(type)) return { kind: "session_end", reason: type };
  if (/error|exceeded|limited|overflow|exhausted|throttled|terms|insufficient/.test(type) || typeof m.error === "string") {
    return { kind: "error", code: type, ...(str(m.error) ? { message: str(m.error) } : {}) };
  }
  return { kind: "ignored", type };
}

/** Label for words ElevenLabs could not attribute and that start a segment. */
export const UNKNOWN_SPEAKER = "unknown";

/**
 * Group a diarized segment's words into speaker runs: consecutive words with one speaker.
 * Spacing tokens (and words without a speaker) stay in the current run. Times are
 * session-relative ms. runIndex counts from 0 within the segment, so the key
 * (session, segmentIndex, runIndex) comes from ElevenLabs alone.
 */
export function toRuns(ev: DiarizedEvent): Run[] {
  const hasSpacing = ev.words.some((w) => w.spacing);
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const w of ev.words) {
    if (w.spacing || (w.speaker === null && cur)) {
      if (cur) {
        cur.text += !w.spacing && !hasSpacing ? ` ${w.text}` : w.text;
        if (!w.spacing && w.endMs > cur.endMs) cur.endMs = w.endMs;
      }
      continue;
    }
    const speaker = w.speaker ?? UNKNOWN_SPEAKER;
    if (!cur || cur.speaker !== speaker) {
      cur = { segmentIndex: ev.segmentIndex, runIndex: runs.length, speaker, text: "", startMs: w.startMs, endMs: w.endMs };
      runs.push(cur);
    } else if (!hasSpacing) {
      cur.text += " ";
    }
    cur.text += w.text;
    if (w.endMs > cur.endMs) cur.endMs = w.endMs;
  }
  return runs
    // A word without an end time (0) must not make endMs < startMs (the ingest rejects that).
    .map((r) => ({ ...r, text: r.text.trim(), endMs: Math.max(r.startMs, r.endMs) }))
    .filter((r) => r.text !== "")
    .map((r, i) => ({ ...r, runIndex: i }));
}
