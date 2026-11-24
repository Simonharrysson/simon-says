import "server-only";
import { randomUUID } from "node:crypto";
import { endMeeting, maybeTick, type EndResult } from "@/lib/meetings/tick";
import { IngestError, ingestSegments } from "@/lib/segments/ingest";
import type { SegmentIn } from "@/lib/segments/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { FIXTURE_LINES, FIXTURE_SPEAKER_NAMES, toSegments, type FixtureLine } from "./fixture";

// Testmöte: replay the fictional meeting as ElevenLabs would deliver it, but from the server.
// Everything after the segments is the real path: ingestSegments (the same function the
// /segments route calls), maybeTick (45 s floor in real time), endMeeting (final pass).

export const SPEED = 3;
export const BATCH_INTERVAL_MS = 5000;
/** The route's maxDuration is 300 s; the end must have started its work well before that. */
export const END_DEADLINE_MS = 285_000;
/** The stand-in session is long enough for the whole fixture (10 min) plus slack. */
export const TEST_SESSION_SECONDS = 900;

export interface Batch {
  /** Real ms after feed start when the batch is posted. */
  atMs: number;
  segments: SegmentIn[];
}

/** Real ms after feed start at which a line is due: startMs / speed. */
export const dueMs = (line: Pick<FixtureLine, "startMs">, speed = SPEED): number => line.startMs / speed;

/** Group the lines into batches posted every `intervalMs` of real time; each batch holds the lines due by then. */
export function planBatches(
  lines: FixtureLine[],
  elSessionId: string,
  speed = SPEED,
  intervalMs = BATCH_INTERVAL_MS,
): Batch[] {
  const segments = toSegments(lines, elSessionId);
  const batches: Batch[] = [];
  let k = 0;
  for (let i = 0; i < lines.length; ) {
    const atMs = ++k * intervalMs;
    const taken: SegmentIn[] = [];
    while (i < lines.length && dueMs(lines[i], speed) <= atMs) taken.push(segments[i++]);
    if (taken.length > 0) batches.push({ atMs, segments: taken });
  }
  return batches;
}

/** The ElevenLabs stand-in session, current for the meeting, plus the speaker names (the name round's result). */
export async function seedTestSession(meetingId: string): Promise<string> {
  const db = supabaseAdmin();
  const sessionId = `test-${randomUUID()}`;
  const { error: se } = await db
    .from("el_sessions")
    .insert({ id: sessionId, meeting_id: meetingId, max_seconds: TEST_SESSION_SECONDS, kind: "test" });
  if (se) throw new Error(`test meeting: session: ${se.message}`);
  const { error: me } = await db
    .from("meetings")
    .update({ current_el_session_id: sessionId, last_heartbeat_at: new Date().toISOString() })
    .eq("id", meetingId);
  if (me) throw new Error(`test meeting: current session: ${me.message}`);
  const { error: pe } = await db.from("speaker_map").insert(
    Object.entries(FIXTURE_SPEAKER_NAMES).map(([label, name]) => ({
      meeting_id: meetingId,
      el_session_id: sessionId,
      speaker_label: label,
      display_name: name,
    })),
  );
  if (pe) throw new Error(`test meeting: speakers: ${pe.message}`);
  return sessionId;
}

export interface FeedDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ingest: (meetingId: string, segments: SegmentIn[]) => Promise<unknown>;
  heartbeat: (meetingId: string) => Promise<void>;
  tick: (meetingId: string) => Promise<void>;
  end: (meetingId: string, opts: { deadlineAt: Date }) => Promise<EndResult>;
}

export const realDeps: FeedDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
  ingest: (id, segments) => ingestSegments(id, segments),
  heartbeat: async (id) => {
    const { error } = await supabaseAdmin()
      .from("meetings")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", id);
    if (error) console.error(`test meeting ${id}: heartbeat: ${error.message}`);
  },
  tick: (id) => maybeTick(id),
  end: (id, opts) => endMeeting(id, opts),
};

/**
 * Replay the batches in real time, then end the meeting. `startedAt` is the invocation start
 * (the end deadline is counted from it). Ticks run in the background (never awaited inline, so
 * the replay keeps its pace) and are all awaited before the end, so nothing is cut. A failed
 * batch is retried once; a meeting that is no longer live stops the replay. Never throws.
 */
export async function runFeed(
  meetingId: string,
  elSessionId: string,
  startedAt: number,
  deps: FeedDeps = realDeps,
  lines: FixtureLine[] = FIXTURE_LINES,
): Promise<EndResult | "error"> {
  const ticks: Promise<void>[] = [];
  try {
    const feedStart = deps.now();
    for (const batch of planBatches(lines, elSessionId)) {
      await deps.sleep(feedStart + batch.atMs - deps.now());
      try {
        try {
          await deps.ingest(meetingId, batch.segments);
        } catch (e) {
          if (e instanceof IngestError) throw e;
          await deps.ingest(meetingId, batch.segments); // idempotent: safe to resend
        }
      } catch (e) {
        console.error(`test meeting ${meetingId}: ingest: ${(e as Error).message}`);
        if (e instanceof IngestError && e.code === "meeting_not_live") break;
        continue;
      }
      await deps.heartbeat(meetingId);
      ticks.push(deps.tick(meetingId));
    }
  } catch (e) {
    console.error(`test meeting ${meetingId}: feed: ${(e as Error).message}`);
  }
  await Promise.allSettled(ticks);
  try {
    return await deps.end(meetingId, { deadlineAt: new Date(startedAt + END_DEADLINE_MS) });
  } catch (e) {
    console.error(`test meeting ${meetingId}: end: ${(e as Error).message}`);
    return "error";
  }
}
