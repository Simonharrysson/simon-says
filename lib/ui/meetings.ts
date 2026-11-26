import type { MeetingStatus } from "@/lib/db/types";

// Presentation rules for meeting rows. They mirror the server's rules in lib/db/orgs.ts
// (deleteMeeting) so the UI only offers what will succeed; the server still decides.

export type MeetingDeleteState = "allowed" | "active" | "forbidden";

const ACTIVE: MeetingStatus[] = ["live", "ending"];

export function meetingDeleteState(
  meeting: { status: MeetingStatus; started_by: string | null },
  viewer: { isAdmin: boolean; userId: string | null },
): MeetingDeleteState {
  if (ACTIVE.includes(meeting.status)) return "active";
  if (viewer.isAdmin || (viewer.userId !== null && meeting.started_by === viewer.userId)) return "allowed";
  return "forbidden";
}

// Status labels are UI copy: org.status.* in lib/i18n/messages.

export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`;
}

/**
 * An abandoned meeting (a false start or a failed start; one with speech ends as done, see
 * lib/meetings/presence.ts) can be continued for this long after it ended.
 */
export const RESUME_WINDOW_MS = 2 * 3600 * 1000;

/** Whether "Fortsätt mötet" is offered: live, or abandoned < 2 h ago (the resume route decides). */
export function canResume(m: { status: string; ended_at: string | null }, now = Date.now()): boolean {
  if (m.status === "live") return true;
  return m.status === "abandoned" && m.ended_at !== null && now - new Date(m.ended_at).getTime() < RESUME_WINDOW_MS;
}
