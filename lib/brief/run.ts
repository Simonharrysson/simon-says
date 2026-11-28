import type { CalendarApi } from "@/lib/calendar/api";
import { isOrgCalendarId, matchesFilter, stockholmDateTime, type CalendarEvent } from "@/lib/calendar/events";
import { customerDomain } from "@/lib/foretag/customers";
import type { HomeMeeting, HomeNoteRow, HomePerson } from "@/lib/home/tasks";
import type { Locale } from "@/lib/i18n/config";
import { briefContent, chooseDecisions, BRIEF_DECISIONS, type BriefAgenda } from "./content";
import { renderBriefEmail, type BriefEmailInput } from "./email";
import type { PickFn } from "./pick";
import { BRIEF_LEAD_MS, briefEventKey, declinedBy, guestEmails, inBriefWindow, invitedTo } from "./window";

// Inför möten (0059): one user's briefs for one cron run. The I/O is injected (BriefDeps; the
// real one is lib/brief/store.ts), so the order of checks, the visibility and the sent-log are
// unit-tested without a database or Google.
//
// Order (nothing is read that the user has not allowed):
// 1. which spaces may brief at all: every Företag (meeting_brief is on by default), a förening
//    only with a calendar AND the user's opt-in (user_settings.brief_foreningar, default off);
//    none → done, Google is never asked;
// 2. the gate (may_email 'meeting_brief': the category, "Inga mejl alls", unsubscribes); no →
//    done, Google is never asked;
// 3. the user's calendars, with the user's OWN grant: each eligible space's shared calendar (its
//    title filter applied; only events the user is invited to: organiser or a guest who has not
//    declined), and their own primary calendar when they are in a Företag (customer
//    meetings, by the guests' e-mail domain: an existing customer only, never created);
// 4. per event starting within 15 minutes (not declined, not already in the sent-log): CLAIM the
//    sent-log row first (a lease: a run killed mid-brief leaves it to a later run, at most 3
//    tries, the mail's Idempotency-Key keeping a retry from delivering twice), then build from the
//    user's own visibility, then mail (or mark skipped).
// Logs: counts only (no titles, names, addresses or ids).

export interface BriefSpace {
  id: string;
  name: string;
  kind: "forening" | "foretag" | "privat";
  calendarId: string | null;
  calendarFilter: string | null;
}

export interface BriefUser {
  id: string;
  email: string | null;
  /** Every address of the account (sign-in + the addresses spaces list for it), for the invite check. */
  emails: string[];
  name: string | null;
  locale: Locale;
  /** Opted in to förening briefs (Konto → Mejl). */
  briefForeningar: boolean;
  spaces: BriefSpace[];
}

export type BriefScope =
  | { kind: "org"; org: BriefSpace }
  | { kind: "customer"; org: BriefSpace; customer: { id: string; name: string } };

export interface BriefHistory {
  /** Meetings in scope that the user can see (visible_meeting_ids), finished, newest first. */
  meetings: HomeMeeting[];
  rows: HomeNoteRow[];
  people: HomePerson[];
  agenda: BriefAgenda | null;
  /** 0068: the meetings whose transcript the user may read (transcript_visible_ids): their decisions show "▶ 41:52". */
  transcriptMeetings?: string[];
}

export type BriefState = "sent" | "skipped" | "opted_out" | "failed" | "uncertain";

export interface BriefMail {
  subject: string;
  text: string;
  html: string;
  /** Resend Idempotency-Key: a retried send is never delivered twice. */
  idempotencyKey: string;
}

export interface BriefDeps {
  now(): Date;
  gate(user: BriefUser): Promise<"allowed" | "opted_out" | "unknown" | "invalid">;
  calendar(userId: string): Promise<Pick<CalendarApi, "listEvents">>;
  /** The company's own e-mail domains (its members' sign-in domains). */
  ownDomains(orgId: string): Promise<string[]>;
  /** An EXISTING customer of the company for the domain (read only), or null. */
  customerByDomain(orgId: string, domain: string): Promise<{ id: string; name: string } | null>;
  /** Which of these sent-log keys exist for the user. */
  sentKeys(userId: string, keys: string[]): Promise<Set<string>>;
  /** Claim the sent-log row under a lease (or take over an expired claim); false: done, held or out of attempts. */
  claim(userId: string, key: string, startsAt: string, scope: BriefScope["kind"]): Promise<boolean>;
  finish(userId: string, key: string, state: BriefState, picked: boolean | null): Promise<void>;
  history(user: BriefUser, scope: BriefScope, startsAt: string): Promise<BriefHistory>;
  pick: PickFn;
  deliver(user: BriefUser & { email: string }, mail: BriefMail): Promise<"sent" | "opted_out" | "invalid" | "failed" | "uncertain">;
  /** The app's origin (links in the mail). */
  origin: string;
  unsubscribeHref(email: string): string;
}

export interface UserBriefResult {
  /** Why nothing was looked at: no eligible space, or the gate said no. */
  stopped?: "no_space" | "gate" | "calendar";
  sent: number;
  skipped: number;
  failed: number;
}

/** Spaces whose meetings may get a brief for this user. */
export function eligibleSpaces(user: BriefUser): { calendars: BriefSpace[]; foretag: BriefSpace[] } {
  const foretag = user.spaces.filter((s) => s.kind === "foretag");
  const calendars = user.spaces.filter(
    (s) => s.calendarId && isOrgCalendarId(s.calendarId) && (s.kind === "foretag" || (s.kind === "forening" && user.briefForeningar)),
  );
  return { calendars, foretag };
}

interface Candidate {
  event: CalendarEvent;
  key: string;
  scope: BriefScope;
}

export async function briefsForUser(user: BriefUser, deps: BriefDeps): Promise<UserBriefResult> {
  const out: UserBriefResult = { sent: 0, skipped: 0, failed: 0 };
  const { calendars, foretag } = eligibleSpaces(user);
  if (!calendars.length && !foretag.length) return { ...out, stopped: "no_space" };
  if (!user.email || (await deps.gate(user)) !== "allowed") return { ...out, stopped: "gate" };
  const email = user.email;

  const now = deps.now();
  const from = now;
  const to = new Date(now.getTime() + BRIEF_LEAD_MS + 60_000);
  let api: Pick<CalendarApi, "listEvents">;
  try {
    api = await deps.calendar(user.id);
  } catch {
    return { ...out, stopped: "calendar" };
  }

  // Shared calendars first: a meeting there is the group's, even when it is also in the user's own calendar.
  const byKey = new Map<string, Candidate>();
  const emails = [email, ...user.emails];
  const soon = (e: CalendarEvent) => inBriefWindow(e, now) && !declinedBy(e, emails);
  for (const space of calendars) {
    const events = await api.listEvents(space.calendarId!, from, to, 50).catch(() => [] as CalendarEvent[]);
    for (const e of events) {
      if (!soon(e) || !matchesFilter(e.title, space.calendarFilter) || !invitedTo(e, emails)) continue;
      const key = briefEventKey(e.id);
      if (!byKey.has(key)) byKey.set(key, { event: e, key, scope: { kind: "org", org: space } });
    }
  }
  if (foretag.length) {
    const events = await api.listEvents("primary", from, to, 50).catch(() => [] as CalendarEvent[]);
    for (const e of events) {
      const key = briefEventKey(e.id);
      if (!soon(e) || byKey.has(key)) continue;
      const guests = guestEmails(e, emails);
      if (!guests.length) continue;
      for (const org of foretag) {
        const domain = customerDomain(guests, await deps.ownDomains(org.id));
        const customer = domain ? await deps.customerByDomain(org.id, domain) : null;
        if (customer) {
          byKey.set(key, { event: e, key, scope: { kind: "customer", org, customer } });
          break;
        }
      }
    }
  }
  if (!byKey.size) return out;

  const done = await deps.sentKeys(user.id, [...byKey.keys()]);
  for (const c of byKey.values()) {
    if (done.has(c.key)) continue;
    if (!(await deps.claim(user.id, c.key, c.event.start, c.scope.kind))) continue;
    try {
      const state = await buildAndSend(user, email, c, deps);
      if (state.state === "sent") out.sent++;
      else if (state.state === "skipped" || state.state === "opted_out") out.skipped++;
      else out.failed++;
      await deps.finish(user.id, c.key, state.state, state.picked);
    } catch (err) {
      out.failed++;
      console.error(`brief: build failed: ${(err as Error).name}`);
      await deps.finish(user.id, c.key, "failed", null).catch(() => undefined);
    }
  }
  return out;
}

async function buildAndSend(user: BriefUser, email: string, c: Candidate, deps: BriefDeps): Promise<{ state: BriefState; picked: boolean | null }> {
  const history = await deps.history(user, c.scope, c.event.start);
  const orgId = c.scope.org.id;
  const content = briefContent({
    userId: user.id,
    orgId,
    meetings: history.meetings,
    rows: history.rows,
    people: history.people,
    agenda: history.agenda,
    transcriptMeetings: history.transcriptMeetings,
    today: stockholmDateTime(deps.now().toISOString()).date,
    meetingHref: (id) => `${deps.origin}/orgs/${orgId}/mote/${id}`,
  });
  if (!content) return { state: "skipped", picked: null };
  let picked: string[] | null = null;
  if (content.decisions.length > BRIEF_DECISIONS) picked = await deps.pick({ title: c.event.title, decisions: content.decisions, orgId }).catch(() => null);
  const input: BriefEmailInput = {
    locale: user.locale,
    recipientName: user.name,
    eventTitle: c.event.title,
    startsAt: c.event.start,
    groupName: c.scope.kind === "customer" ? c.scope.customer.name : c.scope.org.name,
    spaceName: c.scope.org.name,
    content,
    decisions: chooseDecisions(content.decisions, picked),
    unsubscribeHref: deps.unsubscribeHref(email),
  };
  const mail = renderBriefEmail(input);
  const result = await deps.deliver(
    { ...user, email },
    { subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `brief-${user.id}-${c.key.slice(0, 32)}` },
  );
  const state: BriefState = result === "invalid" ? "failed" : result;
  return { state, picked: picked ? picked.length > 0 : false };
}
