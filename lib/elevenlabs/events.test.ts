import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEvent, toRuns, type DiarizedEvent, type ParsedEvent } from "./events";

const lines = readFileSync(new URL("../../fixtures/elevenlabs/provisional.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n");
const events: ParsedEvent[] = lines.map(parseEvent);
const diarized = events.filter((e): e is DiarizedEvent => e.kind === "diarized");

describe("parseEvent on the provisional fixture", () => {
  it("parses every line without throwing and finds each kind", () => {
    expect(events.map((e) => e.kind)).toEqual([
      "started",
      "partial",
      "partial",
      "committed",
      "committed",
      "diarized",
      "partial",
      "committed",
      "committed",
      "diarized",
      "error",
      "committed",
      "diarized",
      "merged",
      "ignored",
      "session_end",
    ]);
  });

  it("diarized count equals the fixture's (3 segments)", () => {
    expect(diarized.map((d) => d.segmentIndex)).toEqual([0, 1, 2]);
  });

  it("partial and committed carry the text; committed keeps the segment index and language", () => {
    expect(events[2]).toEqual({ kind: "partial", text: "Hej allihop, välkomna" });
    expect(events[3]).toEqual({ kind: "committed", segmentIndex: 0, text: "Hej allihop, välkomna." });
    expect(events[4]).toMatchObject({ kind: "committed", segmentIndex: 0, lang: "sv", startMs: 120, endMs: 1600 });
  });

  it("session-limit message → session_end", () => {
    expect(events.at(-1)).toEqual({ kind: "session_end", reason: "session_time_limit_exceeded" });
  });

  it("merge event parsed (single id and list form)", () => {
    expect(events[13]).toEqual({ kind: "merged", from: ["speaker_2"], into: "speaker_1" });
    expect(
      parseEvent(JSON.stringify({ message_type: "speakers_merged", from_speaker_ids: ["a", "b"], into_speaker_id: "c" })),
    ).toEqual({ kind: "merged", from: ["a", "b"], into: "c" });
  });

  it("errors keep their type as code; junk is ignored, never thrown", () => {
    expect(events[10]).toMatchObject({ kind: "error", code: "commit_throttled" });
    expect(parseEvent(JSON.stringify({ message_type: "auth_error", error: "bad token" }))).toEqual({
      kind: "error",
      code: "auth_error",
      message: "bad token",
    });
    expect(parseEvent("not json")).toEqual({ kind: "ignored", type: "not_json" });
    expect(parseEvent("[1]")).toEqual({ kind: "ignored", type: "not_an_object" });
    expect(parseEvent(JSON.stringify({ message_type: "diarized_transcript" }))).toEqual({ kind: "ignored", type: "diarized_transcript" });
  });
});

describe("toRuns", () => {
  it("one speaker → one run with spacing kept and ms times", () => {
    expect(toRuns(diarized[0])).toEqual([
      { segmentIndex: 0, runIndex: 0, speaker: "speaker_0", text: "Hej allihop, välkomna.", startMs: 120, endMs: 1600 },
    ]);
  });

  it("runs split exactly where the speaker changes", () => {
    expect(toRuns(diarized[1])).toEqual([
      { segmentIndex: 1, runIndex: 0, speaker: "speaker_1", text: "Tack. Ska vi börja?", startMs: 2000, endMs: 3100 },
      { segmentIndex: 1, runIndex: 1, speaker: "speaker_2", text: "Ja, let's", startMs: 3300, endMs: 3800 },
      { segmentIndex: 1, runIndex: 2, speaker: "speaker_0", text: "start.", startMs: 3850, endMs: 4200 },
    ]);
  });

  it("keeps the language of the diarized event out of the run (the caller adds it)", () => {
    expect(diarized[2].lang).toBe("sv");
    expect(toRuns(diarized[2])).toHaveLength(1);
  });

  it("joins words with a space when there are no spacing tokens; unattributed words stay in the run", () => {
    const ev: DiarizedEvent = {
      kind: "diarized",
      segmentIndex: 7,
      words: [
        { text: "a", speaker: null, startMs: 0, endMs: 10 },
        { text: "b", speaker: "s1", startMs: 20, endMs: 30 },
        { text: "c", speaker: null, startMs: 40, endMs: 50 },
        { text: "d", speaker: "s1", startMs: 60, endMs: 70 },
      ],
    };
    expect(toRuns(ev)).toEqual([
      { segmentIndex: 7, runIndex: 0, speaker: "unknown", text: "a", startMs: 0, endMs: 10 },
      { segmentIndex: 7, runIndex: 1, speaker: "s1", text: "b c d", startMs: 20, endMs: 70 },
    ]);
  });

  it("a word without an end time never makes endMs < startMs", () => {
    const ev: DiarizedEvent = {
      kind: "diarized",
      segmentIndex: 1,
      words: [{ text: "hm", speaker: "s", startMs: 900, endMs: 0 }],
    };
    expect(toRuns(ev)[0]).toMatchObject({ startMs: 900, endMs: 900 });
  });

  it("no words → no runs", () => {
    expect(toRuns({ kind: "diarized", segmentIndex: 0, words: [] })).toEqual([]);
  });
});
