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

export const meetingStatusLabel: Record<MeetingStatus, string> = {
  live: "Pågår",
  ending: "Avslutas",
  done: "Klart",
  abandoned: "Avbrutet",
};

export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`;
}
