import expected from "@/fixtures/notes/synthetic.expected.json";
import agendaExpected from "@/fixtures/notes/veckomote-a.expected.json";
import type { PersonRow } from "@/lib/db/types";
import type { SegmentIn } from "@/lib/segments/types";
import rawLines from "./synthetic-lines.json";
import rawLinesA from "./veckomote-a-lines.json";
import rawLinesB from "./veckomote-b-lines.json";

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
/** Speaker label (`speaker_0`, without the `S1-` prefix) → display name. Test oracle only: the name round must find these. */
export const FIXTURE_SPEAKER_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(expected.speakerNames).map(([label, name]) => [stripSessionPrefix(label), name]),
);

/**
 * "Testmöte med dagordning" (A13): the fictional Veckomöte of Ekdala Padelklubb, run A (the first
 * week) and run B (the week after). Copies of fixtures/notes/veckomote-a/-b.jsonl; a test keeps
 * them identical.
 */
export const AGENDA_FIXTURE_LINES: Record<"a" | "b", FixtureLine[]> = {
  a: rawLinesA as FixtureLine[],
  b: rawLinesB as FixtureLine[],
};

/** The agenda fixture's five fictional people and their roles (veckomote-a.expected.json `people`). */
export const AGENDA_TEST_PEOPLE: { name: string; role: string }[] = agendaExpected.people;

/**
 * Does this meeting take its people from the agenda fixture instead of the förening's people
 * rows? Only agenda-mode Testmöten (is_test and agenda_doc): their speakers are the fixture's
 * fictional people, and test sessions never read or write real people (Ruling 38). The old
 * Testmöte (a new Doc) keeps the förening's people.
 */
export function usesTestPeople(meeting: { is_test?: boolean | null; agenda_doc?: boolean | null }): boolean {
  return meeting.is_test === true && meeting.agenda_doc === true;
}

/**
 * The fixture's people as people rows of `orgId`, for owner labels and Claude's people list. The
 * ids are not people ids (no rows exist): never store them as `owner_person_id`.
 */
export function testPeople(orgId: string): PersonRow[] {
  return AGENDA_TEST_PEOPLE.map((p, i) => ({ id: `test-person-${i + 1}`, org_id: orgId, name: p.name, member_user_id: null, role: p.role }));
}

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
