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
  self_linked_at?: string | null;
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
  /** The member linked themselves to this name within SELF_LINK_RECENT_DAYS (0051): "Nyss kopplad". */
  selfLinkedAt?: string | null;
}

/** How long the admins' list marks a self link "Nyss kopplad" (with "Det stämmer inte"). */
export const SELF_LINK_RECENT_DAYS = 14;

function recentSelfLink(at: string | null | undefined, now: number): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) && now - t < SELF_LINK_RECENT_DAYS * 86_400_000 ? at : null;
}

export function boardRows(people: BoardPerson[], members: BoardMember[], now: number = Date.now()): BoardRow[] {
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
      selfLinkedAt: member ? recentSelfLink(p.self_linked_at, now) : null,
    };
  });
  const unnamed: BoardRow[] = members
    .filter((m) => !linked.has(m.userId))
    .map((m) => ({ personId: null, name: null, role: null, email: m.email || null, status: "account", member: m, voiceConsent: false, selfLinkedAt: null }));
  return [...rows, ...unnamed];
}

/** A plausible e-mail address (the DB checks the same shape); trimmed and lowercased, or null. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}
