// Who may do what with a meeting. Any member of the förening may run (continue) a live
// meeting from their own device; the meeting keeps writing with the starter's Google access.
// The org page's "Avsluta mötet" is for admins and the starter; the end route accepts any
// member, since whoever runs the meeting ends it from the live page.

export type OrgRole = "admin" | "member" | null;

/** Run the live page: token, segments, heartbeat, pause, speakers, "Fortsätt mötet". */
export function canRunMeeting(role: OrgRole): boolean {
  return role === "admin" || role === "member";
}

/** POST /end (the live page's Avsluta, also for a member who took over). */
export function canEndMeeting(role: OrgRole): boolean {
  return canRunMeeting(role);
}

/** The "Avsluta mötet" action on the org page's meeting row. */
export function canEndFromOrgPage(role: OrgRole, isStarter: boolean): boolean {
  return role === "admin" || (isStarter && canRunMeeting(role));
}
