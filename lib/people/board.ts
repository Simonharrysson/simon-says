// The board as ONE list (onboarding step 2, audit U3/M1): people (names + roles, used in the
// notes) and member accounts (who can sign in) were two lists of the same humans. A person row is
// linked to an account through people.member_user_id; an e-mail on a person invites them and
// links them when they join (migration 0035). Members nobody has named yet still show, so no
// existing member vanishes. Pure.

export interface BoardPerson {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  member_user_id: string | null;
  voice_consent_at?: string | null;
}

export interface BoardMember {
  userId: string;
  email: string;
  role: "admin" | "member";
}

/** account: linked to a member · invited: has an e-mail, not joined yet · name: only a name. */
export type BoardStatus = "account" | "invited" | "name";

export interface BoardRow {
  /** The person row; null for a member nobody has named yet. */
  personId: string | null;
  name: string | null;
  role: string | null;
  email: string | null;
  status: BoardStatus;
  /** The linked (or unnamed) member's account. */
  member: BoardMember | null;
  voiceConsent: boolean;
}

export function boardRows(people: BoardPerson[], members: BoardMember[]): BoardRow[] {
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const linked = new Set<string>();
  const rows: BoardRow[] = people.map((p) => {
    const member = p.member_user_id ? (byUser.get(p.member_user_id) ?? null) : null;
    if (member) linked.add(member.userId);
    return {
      personId: p.id,
      name: p.name,
      role: p.role ?? null,
      // The person's own (invite) address first: after an admin changes it, the list shows the new one.
      email: p.email || member?.email || null,
      status: member ? "account" : p.email ? "invited" : "name",
      member,
      voiceConsent: Boolean(p.voice_consent_at),
    };
  });
  const unnamed: BoardRow[] = members
    .filter((m) => !linked.has(m.userId))
    .map((m) => ({ personId: null, name: null, role: null, email: m.email || null, status: "account", member: m, voiceConsent: false }));
  return [...rows, ...unnamed];
}

/** A plausible e-mail address (the DB checks the same shape); trimmed and lowercased, or null. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

/** A mailto: link with the invite, so the admin sends it from their own mail (Simon Says sends no mail). */
export function inviteMailto(to: string, orgName: string, inviteUrl: string, name?: string | null): string {
  const subject = `Välkommen till ${orgName} i Simon Says`;
  const body = [
    `Hej${name ? ` ${name.split(" ")[0]}` : ""}!`,
    "",
    `Vi använder Simon Says för anteckningarna på våra möten i ${orgName}. Öppna länken och logga in med Google, så kommer du med:`,
    "",
    inviteUrl,
  ].join("\n");
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
