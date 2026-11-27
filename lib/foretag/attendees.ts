// Calendar guests → member accounts (0050 meeting_attendees). Pure. Fail closed: only an exact
// (case-insensitive) match of a guest's address with a member's sign-in address counts.

export function attendeeIdsFor(guestEmails: string[], members: { userId: string; email: string }[]): string[] {
  const byEmail = new Map(members.filter((m) => m.email).map((m) => [m.email.trim().toLowerCase(), m.userId]));
  const out: string[] = [];
  for (const e of guestEmails) {
    const id = byEmail.get(e.trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
