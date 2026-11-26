import type { SummaryMode } from "@/lib/db/types";
import { resolveSpeaker } from "@/lib/segments/resolve";

// Who gets a meeting's summary e-mail (Simon's todo, migration 0037). Pure over rows; the sender
// (./send.ts) reads them. Recipients are only people in the förening's people list:
// - an address: the linked member account's sign-in address, else the person's own (0035) e-mail;
//   none → no e-mail; the same address twice → once;
// - opting out is the e-mail gate's job (0039, category meeting_summary), checked at send time;
// - missed (default): only people who were NOT at the meeting. Present = a named voice (speaker
//   map, through merges), a Närvarande name (the attendee rows, by full or first name; an
//   ambiguous first name counts everyone it could mean as present: better one summary too few than
//   a "Du missade mötet" to someone who was there), or the account that started the meeting.
//   Only when attendance is certain (someone identified by voice or Närvarande, no unnamed voice
//   like "Talare 2" on a shared mic, and no Närvarande text that names nobody in the list, like
//   "hela styrelsen"); otherwise nobody is mailed in this mode;
// - a person whose member link was removed (0018) gets nothing by their old address;
// - all: everyone; selected: the ticked people; off: nobody.

export interface SummaryPerson {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  member_user_id?: string | null;
  summary_selected?: boolean | null;
  /** 0037: the linked member was removed from the förening (or deleted their account). */
  summary_removed_at?: string | null;
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
  needs_confirm?: boolean | null;
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

/**
 * The names in a Närvarande text: one row may hold one name or a typed list ("Närvarande: Anna,
 * Erik och Sara").
 */
export function attendeeNames(text: string): string[] {
  return text
    .replace(/^\s*närvarande\s*:?/i, "")
    .split(/,|;|\n|\s+och\s+|\s+&\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A voice nobody has named: its own label, "Talare n", or an unsure guess ("Anna?", needs confirm). */
function unnamedVoice(res: { label: string; displayName: string; personId: string | null }, needsConfirm: boolean): boolean {
  if (res.personId && !needsConfirm) return false;
  const name = res.displayName.trim();
  return needsConfirm || name === res.label || /^talare\s*\d+$/i.test(name) || /^speaker_?\d+$/i.test(name) || name.endsWith("?");
}

export interface Attendance {
  /** People ids who were there: named voices, Närvarande names, and the starter's account. */
  present: Set<string>;
  /**
   * We know who was there: at least one attendee identified by voice or Närvarande (the starter
   * alone doesn't count) and every voice named. Otherwise "Du missade mötet" could hit someone who
   * sat in the room under "Talare 2" (a shared mic).
   */
  certain: boolean;
  /** Voices heard that nobody named (for the event log; a count only). */
  unnamedVoices: number;
  /** Närvarande entries that name nobody in the people list (a count only). */
  unmatchedNames: number;
}

/** Who was at the meeting (see the rules above). */
export function presentPeople(input: {
  people: Pick<SummaryPerson, "id" | "name" | "member_user_id">[];
  speakers: SummarySpeaker[];
  /** Texts of the meeting's Närvarande rows (one name or a typed list each). */
  attendeeNames: string[];
  startedBy: string | null;
}): Attendance {
  const known = new Set(input.people.map((p) => p.id));
  const present = new Set<string>();
  let identified = 0;
  const unnamed = new Set<string>();
  const bySession = new Map<string, SummarySpeaker[]>();
  for (const s of input.speakers) bySession.set(s.el_session_id, [...(bySession.get(s.el_session_id) ?? []), s]);
  for (const [session, rows] of bySession) {
    for (const s of rows) {
      const res = resolveSpeaker(rows, s.speaker_label);
      const target = rows.find((r) => r.speaker_label === res.label);
      if (unnamedVoice(res, Boolean(target?.needs_confirm))) {
        unnamed.add(`${session}\u0000${res.label}`);
        continue;
      }
      identified++;
      if (res.personId && known.has(res.personId)) present.add(res.personId);
      else for (const id of peopleNamed(res.displayName, input.people)) present.add(id);
    }
  }
  // Närvarande text counts only when it names people in the list; anything else ("hela styrelsen",
  // "alla", a name we don't know) leaves attendance uncertain.
  let unmatched = 0;
  for (const text of input.attendeeNames) {
    for (const name of attendeeNames(text)) {
      const ids = peopleNamed(name, input.people);
      if (!ids.length) {
        unmatched++;
        continue;
      }
      identified++;
      for (const id of ids) present.add(id);
    }
  }
  if (input.startedBy) for (const p of input.people) if (p.member_user_id === input.startedBy) present.add(p.id);
  return { present, certain: identified > 0 && unnamed.size === 0 && unmatched === 0, unnamedVoices: unnamed.size, unmatchedNames: unmatched };
}

/** Everyone who gets the summary, in people-list order (by name). */
export function summaryRecipients(input: {
  mode: SummaryMode;
  people: SummaryPerson[];
  members: SummaryMember[];
  attendance: Pick<Attendance, "present" | "certain">;
}): Recipient[] {
  if (input.mode === "off") return [];
  const { present, certain } = input.attendance;
  // "missed" when we don't know who was there: nobody (the sender logs it as `uncertain`).
  if (input.mode === "missed" && !certain) return [];
  const members = new Map(input.members.map((m) => [m.userId, m]));
  const seen = new Set<string>();
  const out: Recipient[] = [];
  const people = [...input.people].sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id));
  for (const person of people) {
    const member = person.member_user_id ? members.get(person.member_user_id) : undefined;
    // Removed from the förening (0018 unlinks, 0037 marks it): no e-mail by the old address.
    if (!member && person.summary_removed_at) continue;
    const email = (member?.email || person.email || "").trim();
    if (!email || !email.includes("@")) continue;
    // Uncertain attendance ("all" / "selected"): neutral wording, never "Du missade mötet".
    const missed = certain && !present.has(person.id);
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
): { id: string; name: string; role: string | null; hasEmail: boolean; selected: boolean }[] {
  const memberEmail = new Map((members ?? []).map((m) => [m.userId, m.email]));
  return [...people]
    .sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role ?? null,
      hasEmail: Boolean((p.member_user_id && memberEmail.get(p.member_user_id)) || p.email),
      selected: Boolean(p.summary_selected),
    }));
}
