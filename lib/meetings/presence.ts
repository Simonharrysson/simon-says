// Meeting presence, like Google Meet: a meeting is live while at least one tab that runs it is
// connected (its LiveStream heartbeats every 10 s, lib/audio/stream.ts). When no tab has been
// heard from for PRESENCE_GRACE_SEC, the cron (every 5 min) ends the meeting the normal way
// (final pass, status done), so it ends 5–10 min after the last tab went away. Reopening the
// tab within that time ("Fortsätt mötet") just continues it.
//
// 5 min: long enough for a Wi-Fi drop, a reload or a laptop that sleeps a moment to come back;
// short enough that the notes and Översikt are final right after people leave the room.

export const PRESENCE_GRACE_SEC = 5 * 60;
/** A tab counts as connected when it was heard from this recently (heartbeat every 10 s). */
export const CONNECTED_WITHIN_SEC = 45;

/** The heartbeat header carrying the tab's presence token (lib/meetings/presence-token.ts). */
export const PRESENCE_TOKEN_HEADER = "x-presence-token";

export type Presence = "connected" | "grace" | "gone";

/** The last sign of a tab: its heartbeat, or the start when no heartbeat came yet. */
export function lastSeenMs(m: { last_heartbeat_at: string | null; started_at: string }): number {
  return new Date(m.last_heartbeat_at ?? m.started_at).getTime();
}

export function presence(m: { last_heartbeat_at: string | null; started_at: string }, now: number): Presence {
  const age = now - lastSeenMs(m);
  if (age <= CONNECTED_WITHIN_SEC * 1000) return "connected";
  if (age <= PRESENCE_GRACE_SEC * 1000) return "grace";
  return "gone";
}

/**
 * How the cron ends a meeting nobody is connected to: `done` like Avsluta when anything was
 * said, `abandoned` for a meeting with no speech at all (a false start: never a carry source).
 */
export function autoEndStatus(hasSpeech: boolean): "done" | "abandoned" {
  return hasSpeech ? "done" : "abandoned";
}
