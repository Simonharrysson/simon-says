import type { SupabaseClient } from "@supabase/supabase-js";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";

// Per-meeting counts across a förening's chain of meetings: the seed of the org dashboard's data
// (todo #2, feature test suite design feature 4). Pure over rows; `loadMeetingChainSummary` reads
// them with a client the caller passes.
//
// Rules (my call, docs/superpowers/specs/2026-11-26-feature-test-suite-design.md):
// - one row per meeting of the org with the same is_test (Testmöten and real meetings never
//   mix), oldest first; a false start (an ended meeting, often without items) is a row too;
// - a task is a primary task row: kind task (or a legacy action row), not a tasks-section copy
//   (`<id>-t`), not deleted by a human; a decision likewise (kind decision or a legacy decision row);
// - `tasksOpened`: tasks first written in this meeting (not carried in from an earlier one);
// - `tasksClosed`: tasks of this meeting marked done here ("✓ klart" on the row or its tasks copy).
//   A row whose done flag came from a LATER meeting (propagateDone flips the source row when the
//   carried copy is done) is closed by that later meeting, not here;
// - `tasksOpen`: tasks of this meeting still open when it ended (carried-in ones included).

export interface ChainMeeting extends Pick<MeetingRow, "id" | "org_id" | "started_at" | "status"> {
  is_test?: boolean | null;
}

export type ChainItem = Pick<
  NoteItemRow,
  "meeting_id" | "id" | "section" | "kind" | "done" | "deleted_by_human" | "copy_of" | "carried_from_meeting" | "carried_from_id"
>;

export interface MeetingSummary {
  meetingId: string;
  startedAt: string;
  decisions: number;
  tasksOpened: number;
  tasksClosed: number;
  tasksOpen: number;
}

const isCopy = (r: ChainItem) => Boolean(r.copy_of) || r.id.endsWith("-t");
const isTask = (r: ChainItem) => (r.kind === "task" || (r.kind == null && r.section === "action")) && !isCopy(r) && !r.deleted_by_human;
const isDecision = (r: ChainItem) => (r.kind === "decision" || (r.kind == null && r.section === "decision")) && !isCopy(r) && !r.deleted_by_human;
const key = (meetingId: string, id: string) => `${meetingId}\u0000${id}`;

export function meetingChainSummary(
  orgId: string,
  input: { meetings: ChainMeeting[]; items: ChainItem[] },
  opts: { isTest?: boolean } = {},
): MeetingSummary[] {
  const isTest = opts.isTest ?? false;
  const meetings = input.meetings
    .filter((m) => m.org_id === orgId && (m.is_test ?? false) === isTest)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  // Done on the row itself or on its tasks copy (R-A6: a locked primary is done through its copy).
  const doneCopies = new Set(input.items.filter((r) => isCopy(r) && r.done).map((r) => key(r.meeting_id, r.copy_of ?? r.id.slice(0, -2))));
  const done = (r: ChainItem) => Boolean(r.done) || doneCopies.has(key(r.meeting_id, r.id));
  // Sources whose closing happened in a later meeting (that meeting's carried row is done).
  const closedLater = new Set(
    input.items.filter((r) => isTask(r) && r.carried_from_meeting && r.carried_from_id && done(r)).map((r) => key(r.carried_from_meeting!, r.carried_from_id!)),
  );
  const byMeeting = new Map<string, ChainItem[]>();
  for (const r of input.items) byMeeting.set(r.meeting_id, [...(byMeeting.get(r.meeting_id) ?? []), r]);
  return meetings.map((m) => {
    const rows = byMeeting.get(m.id) ?? [];
    const tasks = rows.filter(isTask);
    const closedHere = tasks.filter((r) => done(r) && !closedLater.has(key(m.id, r.id)));
    return {
      meetingId: m.id,
      startedAt: m.started_at,
      decisions: rows.filter(isDecision).length,
      tasksOpened: tasks.filter((r) => r.carried_from_id == null).length,
      tasksClosed: closedHere.length,
      tasksOpen: tasks.length - closedHere.length,
    };
  });
}

/** The org's chain as stored (meetings + note_items), summarised. */
export async function loadMeetingChainSummary(db: SupabaseClient, orgId: string, opts: { isTest?: boolean } = {}): Promise<MeetingSummary[]> {
  const { data: meetings, error } = await db
    .from("meetings")
    .select("id, org_id, started_at, status, is_test")
    .eq("org_id", orgId)
    .eq("is_test", opts.isTest ?? false);
  if (error) throw new Error(`meeting chain: meetings: ${error.message}`);
  const ids = (meetings ?? []).map((m) => m.id as string);
  if (!ids.length) return [];
  const { data: items, error: e2 } = await db
    .from("note_items")
    .select("meeting_id, id, section, kind, done, deleted_by_human, copy_of, carried_from_meeting, carried_from_id")
    .in("meeting_id", ids);
  if (e2) throw new Error(`meeting chain: items: ${e2.message}`);
  return meetingChainSummary(orgId, { meetings: (meetings ?? []) as ChainMeeting[], items: (items ?? []) as ChainItem[] }, opts);
}
