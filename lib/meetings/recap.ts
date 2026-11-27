import type { SupabaseClient } from "@supabase/supabase-js";

// What happened to a finished meeting's summary e-mail (0037), for the meeting page and the Möten
// tab's "just ended" card. Read with the viewer's own client: meetings and meeting_events are
// readable by whoever may see the meeting (RLS), and the events hold counts only (never who or
// what). The per-recipient ledger stays server-only. Never breaks the page: null on any failure.

export type SummaryMode = "missed" | "all" | "selected" | "off";

export type SummaryStatus =
  /** Mailed (all or some): how many got it, and to whom by the setting. */
  | { state: "sent"; sent: number; mode: SummaryMode | null }
  /** Not decided or not finished yet (the sweep runs right after the end). */
  | { state: "pending" }
  /** Turned off in the förening's settings. */
  | { state: "off" }
  /** Nobody to mail, nothing noted, a Testmöte, or from before summaries existed: nothing to say. */
  | { state: "none" };

type SummaryEvent = { detail?: { sent?: unknown; mode?: unknown } | null };

const MODES: SummaryMode[] = ["missed", "all", "selected", "off"];

/** The status from the meeting's `summary_state` and its `summary` events (pure). */
export function summaryStatus(state: string | null | undefined, events: SummaryEvent[]): SummaryStatus {
  if (state == null || state === "sending") return { state: "pending" };
  if (state === "off") return { state: "off" };
  if (state === "sent" || state === "partial") {
    // One event per sweep run; a resumed run mails only the rest, so the runs add up.
    const sent = events.reduce((n, e) => n + (typeof e.detail?.sent === "number" ? e.detail.sent : 0), 0);
    const last = events.at(-1)?.detail?.mode;
    const mode = MODES.find((m) => m === last) ?? null;
    return sent > 0 ? { state: "sent", sent, mode } : { state: "none" };
  }
  return { state: "none" };
}

export async function loadSummaryStatus(db: SupabaseClient, meetingId: string): Promise<SummaryStatus | null> {
  try {
    const [meeting, events] = await Promise.all([
      db.from("meetings").select("summary_state").eq("id", meetingId).maybeSingle(),
      db.from("meeting_events").select("detail").eq("meeting_id", meetingId).eq("kind", "summary").order("at", { ascending: true }),
    ]);
    if (meeting.error || events.error || !meeting.data) return null;
    return summaryStatus((meeting.data as { summary_state?: string | null }).summary_state, (events.data ?? []) as SummaryEvent[]);
  } catch (err) {
    console.error("meeting recap: summary status unavailable", (err as Error)?.message);
    return null;
  }
}
