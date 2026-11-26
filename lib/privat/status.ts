import type { MeetingStatus, SummaryState } from "@/lib/db/types";

// What a Privat recording's page says about its summary. Pure.

/** lib/summaries/send.ts SUMMARY_SWEEP_WINDOW_MS (that module is server-only). */
export const SWEEP_WINDOW_MS = 48 * 3600 * 1000;

/** "pending": still being written; "none": nothing was heard; "failed": it won't come by itself. */
export type SummaryStatus = "ready" | "pending" | "none" | "failed";

export function summaryStatus(
  m: { status: MeetingStatus; summary_state: SummaryState | null; ended_at: string | null },
  hasSummary: boolean,
  now = Date.now(),
): SummaryStatus {
  if (hasSummary) return "ready";
  if (m.status === "abandoned" || m.summary_state === "no_notes" || m.summary_state === "test") return "none";
  if (m.summary_state === null || m.summary_state === "sending") {
    // The cron only picks meetings up for 48 h after they ended: after that it won't come.
    const stale = m.ended_at !== null && now - Date.parse(m.ended_at) > SWEEP_WINDOW_MS;
    return stale ? "failed" : "pending";
  }
  // failed, partial, none, off, sent without a stored summary, …: not on its way.
  return "failed";
}
