import { resolveSpeaker } from "@/lib/segments/resolve";
import type { SummarySpeaker } from "@/lib/summaries/recipients";

// Who gets the growth loop's invite after a meeting (0063, docs/superpowers/specs/2026-11-27-growth-loop-design.md).
// Pure over rows; lib/growth/send.ts reads them. Owner's rules (2026-11-27):
// - candidates: everyone who attended. The guests of the meeting's matched calendar event who did
//   not decline (people in the list by id, `expected`; others by address, meeting_calendar_guests)
//   and the people the name round identified (speaker_map → person, not `needs_confirm`);
// - has an account → never this mail (they stay in the summary flow): a people row linked to an
//   account, or an address that belongs to one (a confirmed sign-in address, or listed at a linked
//   person). Someone whose account uses another address and whose row is not linked can't be told
//   apart: they get the invite at the listed address, and the claim (same address only) explains;
// - one mail per address (trimmed, lowercased); a guest who is also in the people list is one;
// - no address → nothing (counted); never the starter; at most MAX_INVITES per meeting;
// - `allowed`: the people rows that would see this meeting once linked (a förening with groups:
//   the mail is itself access). Calendar guests outside the list get a per-meeting grant at the
//   claim, an explicit exception admins see and revoke, so they are not filtered here.

export const MAX_INVITES = 25;

export interface InvitePerson {
  id: string;
  name: string;
  email?: string | null;
  member_user_id?: string | null;
  /** 0037: a removed member's row: no e-mail by the old address. */
  summary_removed_at?: string | null;
}

export interface CalendarGuest {
  email: string | null;
  name: string | null;
  response: string | null;
}

export type InviteSource = "calendar" | "name_round" | "both";

export interface InviteRecipient {
  email: string;
  name: string | null;
  /** null: a calendar guest outside the people list (the claim gives a per-meeting grant). */
  personId: string | null;
  source: InviteSource;
}

export interface InviteRecipients {
  invites: InviteRecipient[];
  /** Attendees we could not mail: no address. A count only. */
  withoutEmail: number;
  /** Attendees with an account (the summary flow). */
  withAccount: number;
  /** People rows left out by the tree rule. */
  notAllowed: number;
  /** Over MAX_INVITES. */
  capped: number;
}

const clean = (e: string | null | undefined): string | null => {
  const t = (e ?? "").trim().toLowerCase();
  return t.length >= 3 && t.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? t : null;
};

/** People ids the name round named (through merges), never an unsure guess. */
export function namedPeople(speakers: SummarySpeaker[]): Set<string> {
  const out = new Set<string>();
  const bySession = new Map<string, SummarySpeaker[]>();
  for (const s of speakers) bySession.set(s.el_session_id, [...(bySession.get(s.el_session_id) ?? []), s]);
  for (const rows of bySession.values()) {
    for (const s of rows) {
      const res = resolveSpeaker(rows, s.speaker_label);
      const target = rows.find((r) => r.speaker_label === res.label);
      if (res.personId && !target?.needs_confirm) out.add(res.personId);
    }
  }
  return out;
}

export function inviteRecipients(input: {
  people: InvitePerson[];
  /** People ids on the calendar event's guest list who did not decline (meetings.calendar_event). */
  expected: readonly string[];
  /** Calendar guests outside the people list (meeting_calendar_guests). */
  guests: CalendarGuest[];
  /** People ids the name round identified (namedPeople). */
  named: ReadonlySet<string>;
  /** Lower-cased addresses that belong to an account (emails_with_account). */
  accountEmails: ReadonlySet<string>;
  /** The starter's sign-in address (never mailed). */
  starterEmail: string | null;
  /** The starter's account (their own people row is never mailed). */
  startedBy: string | null;
  /** People rows allowed by the tree rule; null = all. */
  allowed?: ReadonlySet<string> | null;
}): InviteRecipients {
  const starter = clean(input.starterEmail);
  const expected = new Set(input.expected);
  const byId = new Map(input.people.map((p) => [p.id, p]));
  const out = new Map<string, InviteRecipient>();
  let withoutEmail = 0;
  let withAccount = 0;
  let notAllowed = 0;

  const ids = [...new Set([...expected, ...input.named])]
    .map((id) => byId.get(id))
    .filter((p): p is InvitePerson => Boolean(p))
    .sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id));
  for (const p of ids) {
    if (p.member_user_id) {
      if (p.member_user_id !== input.startedBy) withAccount++;
      continue;
    }
    if (p.summary_removed_at) continue;
    const email = clean(p.email);
    if (!email) {
      withoutEmail++;
      continue;
    }
    if (email === starter) continue;
    if (input.accountEmails.has(email)) {
      withAccount++;
      continue;
    }
    if (input.allowed && !input.allowed.has(p.id)) {
      notAllowed++;
      continue;
    }
    if (out.has(email)) continue;
    const inCalendar = expected.has(p.id);
    const inRound = input.named.has(p.id);
    out.set(email, { email, name: p.name, personId: p.id, source: inCalendar && inRound ? "both" : inCalendar ? "calendar" : "name_round" });
  }

  // A listed address at someone (even one we left out above) is that person, never a "guest".
  const listed = new Set(input.people.map((p) => clean(p.email)).filter((e): e is string => Boolean(e)));
  const guests = [...input.guests].sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
  for (const g of guests) {
    if (g.response === "declined") continue;
    const email = clean(g.email);
    if (!email) {
      withoutEmail++;
      continue;
    }
    if (email === starter || out.has(email) || listed.has(email)) continue;
    if (input.accountEmails.has(email)) {
      withAccount++;
      continue;
    }
    out.set(email, { email, name: g.name?.trim() || null, personId: null, source: "calendar" });
  }

  const all = [...out.values()];
  return {
    invites: all.slice(0, MAX_INVITES),
    withoutEmail,
    withAccount,
    notAllowed,
    capped: Math.max(0, all.length - MAX_INVITES),
  };
}

/** Stockholm hour of an instant (0–23). */
export function stockholmHour(at: Date): number {
  return Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" }).format(at));
}

/** Reminders go out between 08 and 20 Stockholm time only. */
export function reminderHour(at: Date): boolean {
  const h = stockholmHour(at);
  return h >= 8 && h < 20;
}

/** The reminder window after the invite: at least 48 h, under 96 h (never sent late). */
export const REMINDER_AFTER_MS = 48 * 3600_000;
export const REMINDER_UNTIL_MS = 96 * 3600_000;

/** One invite per address per förening per this long. */
export const ORG_ADDRESS_GAP_MS = 7 * 86_400_000;
/** After this many unclicked invites in a row from one förening, pause that address. */
export const UNCLICKED_PAUSE_AFTER = 3;
export const UNCLICKED_PAUSE_MS = 90 * 86_400_000;

/** Should a new invite from this förening to this address wait? (its earlier invites, newest first) */
export function addressPaused(
  earlier: { sent_at: string | null; clicked_at: string | null; clicked_human_at: string | null; claimed_at: string | null }[],
  now: Date,
): "recent" | "unclicked" | null {
  const t = now.getTime();
  const sent = earlier.filter((e) => e.sent_at).sort((a, b) => Date.parse(b.sent_at!) - Date.parse(a.sent_at!));
  if (sent.length && t - Date.parse(sent[0].sent_at!) < ORG_ADDRESS_GAP_MS) return "recent";
  const last = sent.slice(0, UNCLICKED_PAUSE_AFTER);
  if (
    last.length === UNCLICKED_PAUSE_AFTER &&
    last.every((e) => !e.clicked_at && !e.clicked_human_at && !e.claimed_at) &&
    t - Date.parse(last[0].sent_at!) < UNCLICKED_PAUSE_MS
  ) {
    return "unclicked";
  }
  return null;
}

/** "o•••@exempel.se": the invited address, masked, for the wrong-account page. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}
