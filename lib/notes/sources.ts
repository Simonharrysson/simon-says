// Where in the meeting a decision or task was said (0069, "source moments"). Pure helpers shared
// by the notes engine, the tick, the Doc render, the meeting page, the brief mail and MCP.
//
// Claude cites a transcript line by the bracket time it already starts with (`[00:41:52] S1-…`),
// so the transcript blocks (the cached prefix) stay byte-identical and the citation costs a few
// output tokens only. The server resolves each cited time against the lines it actually sent in
// this call (never a Må-runda placeholder): a time no sent line has is dropped, so a stored source
// always points at a real segment of THIS meeting. What is stored is the segment's own key
// (`<el_session_id>:<segment_index>:<run_index>`, the segments primary key) and its start time.

/** At most this many segments per item (the first is where the link points). */
export const MAX_SOURCES = 3;

/** A transcript line the engine was shown, as a possible source. */
export interface SegmentSource {
  key: string;
  /** Meeting-relative start (segments.start_ms). */
  startMs: number;
}

/** Bracket time (`HH:MM:SS`) → the segments starting in that second, among the lines sent. */
export type SourceIndex = Map<string, SegmentSource[]>;

export function segmentKey(s: { el_session_id: string; segment_index: number; run_index: number }): string {
  return `${s.el_session_id}:${s.segment_index}:${s.run_index}`;
}

/** `<el_session_id>:<segment_index>:<run_index>` → its parts, or null when it is not one. */
export function parseSegmentKey(key: string): { elSessionId: string; segmentIndex: number; runIndex: number } | null {
  const m = /^(.+):(\d{1,9}):(\d{1,9})$/.exec(key);
  if (!m || !m[1]) return null;
  return { elSessionId: m[1], segmentIndex: Number(m[2]), runIndex: Number(m[3]) };
}

/** The bracket time a transcript line starts with (lib/docs/transcript.ts formatTimestamp). */
export function bracketTime(atMs: number): string {
  const s = Math.max(0, Math.floor(atMs / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** A cited time as Claude may write it (`00:41:52`, `[00:41:52]`, `0:41:52`, `41:52`) → `HH:MM:SS`, else null. */
export function normalizeRef(ref: string): string | null {
  const m = /^\[?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*\]?$/.exec(ref.trim());
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (min > 59 || sec > 59) return null;
  return bracketTime((h * 3600 + min * 60 + sec) * 1000);
}

/** Adds the lines of one sent block to `index`. */
export function addToIndex(index: SourceIndex, lines: SegmentSource[]): SourceIndex {
  for (const l of lines) {
    const t = bracketTime(l.startMs);
    const at = index.get(t) ?? [];
    if (!at.some((s) => s.key === l.key)) at.push(l);
    index.set(t, at);
  }
  return index;
}

export interface ResolvedSources {
  /** Segment keys, earliest first, at most MAX_SOURCES. */
  ids: string[];
  /** The earliest one's start (meeting-relative ms): where the link points. */
  saidAtMs: number;
}

/**
 * Cited times → stored sources. Unknown, malformed or duplicate times are dropped; null when none
 * is left (then the item gets no link: never a wrong one).
 */
export function resolveSources(refs: readonly string[] | undefined, index: SourceIndex | undefined): ResolvedSources | null {
  if (!refs?.length || !index?.size) return null;
  const found = new Map<string, SegmentSource>();
  for (const ref of refs.slice(0, MAX_SOURCES * 2)) {
    const t = typeof ref === "string" ? normalizeRef(ref) : null;
    for (const s of (t && index.get(t)) || []) found.set(s.key, s);
  }
  const ids = [...found.values()].sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key)).slice(0, MAX_SOURCES);
  if (!ids.length) return null;
  return { ids: ids.map((s) => s.key), saidAtMs: ids[0].startMs };
}

/** Meeting-relative ms → "41:52" (mm:ss), "1:05:10" from one hour on. */
export function formatSaidAt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  const mmss = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** What the Doc line ends with: " (41:52)", or "" without a source. */
export function saidAtSuffix(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ` (${formatSaidAt(ms)})` : "";
}

/** The done mark a task line may end with after its moment ("… (41:52) ✓ klart"). */
const DONE_TAIL = "✓ klart";

/**
 * `text` without the " (41:52)" we appended for `ms` (a human-edited line keeps its own words
 * only), also when the done mark follows it: "Boka sal. (41:52) ✓ klart" → "Boka sal. ✓ klart".
 */
export function stripSaidAt(text: string, ms: number | null | undefined): string {
  const suffix = saidAtSuffix(ms).trim();
  if (!suffix) return text;
  const t = text.trimEnd();
  if (t.endsWith(suffix)) return t.slice(0, -suffix.length).trimEnd();
  const withDone = `${suffix} ${DONE_TAIL}`;
  if (t.endsWith(withDone)) return `${t.slice(0, -withDone.length).trimEnd()} ${DONE_TAIL}`;
  return text;
}
