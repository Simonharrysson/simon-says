/** One diarized run. Times are session-relative ms (from the start of the ElevenLabs session). */
export interface Run {
  segmentIndex: number;
  runIndex: number;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** A run as posted to the ingest. Key: (elSessionId, segmentIndex, runIndex). */
export type SegmentIn = Run & { elSessionId: string; lang?: string };

/** `from` speaker labels of one ElevenLabs session now mean `into`. */
export interface MergeIn {
  elSessionId: string;
  from: string[];
  into: string;
}
