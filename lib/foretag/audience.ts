// Who a Företag meeting's summary e-mail is for (spec: "mail to the meeting's group + attendees,
// only people who can see it"). Pure; the viewer ids come from the database (foretag_viewer_ids).

export interface AudiencePerson {
  id: string;
  member_user_id: string | null;
  group_id: string | null;
}

/**
 * The people to mail: everyone placed in the meeting's group (every linked person for a Hela
 * företaget meeting), plus the attendees, but only accounts that can see the meeting. People
 * without an account are never mailed (they can't open it).
 */
export function audiencePeople<T extends AudiencePerson>(input: { groupId: string | null; people: T[]; attendeeIds: string[]; viewerIds: string[] }): T[] {
  const viewers = new Set(input.viewerIds);
  const attendees = new Set(input.attendeeIds);
  const seen = new Set<string>();
  return input.people.filter((p) => {
    if (!p.member_user_id || !viewers.has(p.member_user_id) || seen.has(p.member_user_id)) return false;
    const inAudience = input.groupId === null || p.group_id === input.groupId || attendees.has(p.member_user_id);
    if (inAudience) seen.add(p.member_user_id);
    return inAudience;
  });
}

/**
 * A förening with groups (0054): the people its summary may go to, i.e. those whose account can
 * see the meeting. People without an account (an e-mail only) can't open it and never get it.
 */
export function viewerPeople<T extends { member_user_id?: string | null }>(people: T[], viewerIds: string[]): T[] {
  const viewers = new Set(viewerIds);
  return people.filter((p) => Boolean(p.member_user_id && viewers.has(p.member_user_id)));
}
