import expected from "@/fixtures/notes/synthetic.expected.json";
import rawLines from "./synthetic-lines.json";
import type { SegmentIn } from "@/lib/segments/types";

// The fictional board meeting, as TS/JSON modules so it is bundled into the serverless function
// (no runtime file reads). synthetic-lines.json is a copy of fixtures/notes/synthetic.jsonl; a
// test keeps the two identical.

export interface FixtureLine {
  /** `S1-speaker_0`: the first session's label as the notes tests wrote it. */
  speaker: string;
  startMs: number;
  text: string;
}

export const FIXTURE_LINES = rawLines as FixtureLine[];
/** Speaker label (`speaker_0`, without the `S1-` prefix) → display name. */
export const FIXTURE_SPEAKER_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(expected.speakerNames).map(([label, name]) => [stripSessionPrefix(label), name]),
);

/** `S1-speaker_0` → `speaker_0` (labels are stored raw; the tick builds `S<session>-<label>`). */
export function stripSessionPrefix(label: string): string {
  return label.replace(/^S\d+-/, "");
}

/** Last run is given this much length (ms) when there is no next line. */
const LAST_RUN_MS = 5000;
/** A run never lasts longer than this (ms), even across a long pause. */
const MAX_RUN_MS = 20_000;

/** Fixture lines → one run each: segmentIndex = line index, runIndex 0, session-relative times. */
export function toSegments(lines: FixtureLine[], elSessionId: string): SegmentIn[] {
  return lines.map((l, i) => {
    const next = lines[i + 1]?.startMs;
    const end = next !== undefined ? Math.min(next, l.startMs + MAX_RUN_MS) : l.startMs + LAST_RUN_MS;
    return {
      elSessionId,
      segmentIndex: i,
      runIndex: 0,
      speaker: stripSessionPrefix(l.speaker),
      text: l.text,
      startMs: l.startMs,
      endMs: Math.max(l.startMs, end),
    };
  });
}
