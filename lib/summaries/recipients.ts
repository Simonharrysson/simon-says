import type { SummaryMode } from "@/lib/db/types";
import { resolveSpeaker } from "@/lib/segments/resolve";

// Who gets a meeting's summary e-mail (Simon's todo, migration 0037). Pure over rows; the sender
// (./send.ts) reads them. Recipients are only people in the förening's people list:
// - an address: the linked member account's sign-in address, else the person's own (0035) e-mail;
//   none → no e-mail; the same address twice → once;
// - unsubscribed (the e-mail's link) → never, in every mode;
// - missed (default): only people who were NOT at the meeting. Present = a named voice (speaker
//   map, through merges), a Närvarande name (the attendee rows, by full or first name; an
//   ambiguous first name counts everyone it could mean as present: better one summary too few than
//   a "Du missade mötet" to someone who was there), or the account that started the meeting.
//   If nobody at all could be identified, nobody is mailed: we can't tell who missed it;
// - all: everyone; selected: the ticked people; off: nobody.

export interface SummaryPerson {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  member_user_id?: string | null;
  summary_selected?: boolean | null;
  summary_unsubscribed_at?: string | null;
}

export interface SummaryMember {
  userId: string;
  email: string;
  role: "admin" | "member";
}

export interface SummarySpeaker {
  el_session_id: string;
  speaker_label: string;
  person_id: string | null;
  display_name: string;
  merged_into_label?: string | null;
}

export interface Recipient {
  person: SummaryPerson;
  email: string;
  /** Not among the meeting's attendees: "Du missade mötet". */
  missed: boolean;
  /** Linked to an admin account: the footer links to the setting. */
  isAdmin: boolean;
  /** The linked member account, if any. */
  userId: string | null;
}

const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/\?+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("sv");

/** The people a written name means: the full name, else everyone with that first name. */
export function peopleNamed(text: string, people: Pick<SummaryPerson, "id" | "name">[]): string[] {
  const t = norm(text);
  if (!t) return [];
  const full = people.filter((p) => norm(p.name) === t);
  if (full.length) return full.map((p) => p.id);
  const first = t.split(" ")[0];
  return people.filter((p) => norm(p.name).split(" ")[0] === first).map((p) => p.id);
}

/** Ids of the people who were at the meeting (see the rules above). */
export function presentPeople(input: {
  people: Pick<SummaryPerson, "id" | "name" | "member_user_id">[];
  speakers: SummarySpeaker[];
  /** Texts of the meeting's Närvarande rows (one name each, as the Doc shows them). */
  attendeeNames: string[];
  startedBy: string | null;
}): Set<string> {
  const known = new Set(input.people.map((p) => p.id));
  const present = new Set<string>();
  const bySession = new Map<string, SummarySpeaker[]>();
  for (const s of input.speakers) bySession.set(s.el_session_id, [...(bySession.get(s.el_session_id) ?? []), s]);
  for (const rows of bySession.values()) {
    for (const s of rows) {
      const res = resolveSpeaker(rows, s.speaker_label);
      if (res.personId && known.has(res.personId)) present.add(res.personId);
      else if (res.displayName !== res.label) for (const id of peopleNamed(res.displayName, input.people)) present.add(id);
    }
  }
  for (const name of input.attendeeNames) for (const id of peopleNamed(name, input.people)) present.add(id);
  if (input.startedBy) for (const p of input.people) if (p.member_user_id === input.startedBy) present.add(p.id);
  return present;
}

/** Everyone who gets the summary, in people-list order (by name). */
export function summaryRecipients(input: {
  mode: SummaryMode;
  people: SummaryPerson[];
  members: SummaryMember[];
  present: Set<string>;
}): Recipient[] {
  if (input.mode === "off") return [];
  // "missed" without a single identified attendee: we can't tell who missed it.
  if (input.mode === "missed" && input.present.size === 0) return [];
  const members = new Map(input.members.map((m) => [m.userId, m]));
  const seen = new Set<string>();
  const out: Recipient[] = [];
  const people = [...input.people].sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id));
  for (const person of people) {
    if (person.summary_unsubscribed_at) continue;
    const member = person.member_user_id ? members.get(person.member_user_id) : undefined;
    const email = (member?.email || person.email || "").trim();
    if (!email || !email.includes("@")) continue;
    // Nobody identified ("all" / "selected"): neutral wording for everyone, never "missade".
    const missed = input.present.size > 0 && !input.present.has(person.id);
    if (input.mode === "missed" && !missed) continue;
    if (input.mode === "selected" && !person.summary_selected) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ person, email, missed, isAdmin: member?.role === "admin", userId: member?.userId ?? null });
  }
  return out;
}

/** The setting's checkbox list (Inställningar): every person, whether they can get e-mail at all. */
export function summaryOptions(
  people: SummaryPerson[],
  members: Pick<SummaryMember, "userId" | "email">[] | undefined,
): { id: string; name: string; role: string | null; hasEmail: boolean; selected: boolean; unsubscribed: boolean }[] {
  const memberEmail = new Map((members ?? []).map((m) => [m.userId, m.email]));
  return [...people]
    .sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role ?? null,
      hasEmail: Boolean((p.member_user_id && memberEmail.get(p.member_user_id)) || p.email),
      selected: Boolean(p.summary_selected),
      unsubscribed: Boolean(p.summary_unsubscribed_at),
    }));
}
