// The calendar connection's pure parts (todo #14): which events count as the förening's meetings,
// which one a meeting is, and who on its guest list is in the förening's people list. No I/O.

/** One event as Simon Says reads it: title, time and guests. Never the description or place. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO instants (timed events only; all-day events are skipped when parsed). */
  start: string;
  end: string;
  attendees: CalendarAttendee[];
  /** The organiser's address (lower case), when Google gives one. Set only when present. */
  organizer?: string;
}

export interface CalendarAttendee {
  email: string | null;
  name: string | null;
  /** Google's responseStatus: needsAction | declined | tentative | accepted. */
  response: string | null;
}

/** One calendar in the user's list. */
export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

/** "Starta" is offered from this long before the event's start until its end. */
export const NOW_WINDOW_MS = 30 * 60_000;
/** The förening page shows at most this many upcoming events. */
export const UPCOMING_COUNT = 3;
/** Longest title kept (Doc name and header). */
export const TITLE_MAX = 120;
/** Longest title filter. */
export const FILTER_MAX = 60;

/** A title safe for a Doc name and header line: one line, no control characters, capped. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one;
}

/** The admin's filter text, cleaned; "" = no filter. */
export function cleanFilter(raw: unknown): string {
  return cleanTitle(raw).slice(0, FILTER_MAX).trim();
}

/** Does the title pass the förening's filter ("möte": the title contains it, any case)? */
export function matchesFilter(title: string, filter: string | null | undefined): boolean {
  const f = (filter ?? "").trim().toLocaleLowerCase("sv");
  return !f || title.toLocaleLowerCase("sv").includes(f);
}

/** One raw Calendar API event → ours, or null (cancelled, all-day, no id or time). */
export function parseEvent(raw: unknown): CalendarEvent | null {
  const e = raw as {
    id?: unknown;
    status?: unknown;
    summary?: unknown;
    start?: { dateTime?: unknown };
    end?: { dateTime?: unknown };
    organizer?: { email?: unknown };
    attendees?: { email?: unknown; displayName?: unknown; responseStatus?: unknown; resource?: unknown }[];
  } | null;
  if (!e || typeof e.id !== "string" || e.status === "cancelled") return null;
  const start = typeof e.start?.dateTime === "string" ? Date.parse(e.start.dateTime) : NaN;
  const end = typeof e.end?.dateTime === "string" ? Date.parse(e.end.dateTime) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const attendees = (Array.isArray(e.attendees) ? e.attendees : [])
    .filter((a) => a && a.resource !== true)
    .map((a) => ({
      email: typeof a.email === "string" && a.email.includes("@") ? a.email.trim().toLowerCase() : null,
      name: typeof a.displayName === "string" && a.displayName.trim() ? cleanTitle(a.displayName) : null,
      response: typeof a.responseStatus === "string" ? a.responseStatus : null,
    }));
  const organizer = typeof e.organizer?.email === "string" && e.organizer.email.includes("@") ? e.organizer.email.trim().toLowerCase() : null;
  return {
    id: e.id,
    title: cleanTitle(e.summary),
    start: new Date(start).toISOString(),
    end: new Date(Math.max(end, start)).toISOString(),
    attendees,
    ...(organizer ? { organizer } : {}),
  };
}

/** Is the event "now" (from 30 minutes before its start until its end)? */
export function isNow(event: Pick<CalendarEvent, "start" | "end">, now: Date): boolean {
  const t = now.getTime();
  return Date.parse(event.start) - NOW_WINDOW_MS <= t && t <= Math.max(Date.parse(event.end), Date.parse(event.start) + NOW_WINDOW_MS);
}

/** The next events (filtered, not yet over), soonest first, at most `count`. */
export function upcomingEvents(events: CalendarEvent[], now: Date, filter: string | null | undefined, count = UPCOMING_COUNT): CalendarEvent[] {
  return events
    .filter((e) => matchesFilter(e.title, filter) && Math.max(Date.parse(e.end), Date.parse(e.start) + NOW_WINDOW_MS) >= now.getTime())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id))
    .slice(0, count);
}

/** The event a meeting starting now is: of the filtered events that are "now", the one starting closest to now. */
export function eventForNow(events: CalendarEvent[], now: Date, filter: string | null | undefined): CalendarEvent | null {
  const t = now.getTime();
  const live = events.filter((e) => matchesFilter(e.title, filter) && isNow(e, now));
  live.sort((a, b) => Math.abs(Date.parse(a.start) - t) - Math.abs(Date.parse(b.start) - t) || a.id.localeCompare(b.id));
  return live[0] ?? null;
}

/** `YYYY-MM-DD` and `HH:MM` of an instant in Swedish local time (Förbered möte's fields). */
export function stockholmDateTime(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const time = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return { date, time };
}

export interface MatchPerson {
  id: string;
  name: string;
  email?: string | null;
  member_user_id?: string | null;
}

/** What a meeting keeps of its event: the title and the guests as ids of the förening's people. */
export interface MeetingCalendarEvent {
  title: string;
  /** People on the guest list who did not decline: expected at the meeting. */
  expected: string[];
  /** People who declined: clearly absent by the calendar. */
  declined: string[];
  /**
   * At start only, never stored in meetings.calendar_event: guests outside the people list (with an
   * address, not declined), written to meeting_calendar_guests (0067, server only).
   */
  guests?: CalendarAttendee[];
}

const normName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");

/**
 * Guests → the förening's people: by e-mail (the person's own, or their linked member account's),
 * else by exact full name. Never by first name alone (two Annas): a guest we can't place is left out.
 */
export function matchAttendees(
  attendees: CalendarAttendee[],
  people: MatchPerson[],
  memberEmails: Map<string, string>,
): { expected: string[]; declined: string[] } {
  const byEmail = new Map<string, string>();
  for (const p of people) {
    for (const e of [p.email, p.member_user_id ? memberEmails.get(p.member_user_id) : null]) {
      if (e && e.includes("@")) byEmail.set(e.trim().toLowerCase(), p.id);
    }
  }
  const byName = new Map<string, string[]>();
  for (const p of people) byName.set(normName(p.name), [...(byName.get(normName(p.name)) ?? []), p.id]);
  const expected = new Set<string>();
  const declined = new Set<string>();
  for (const a of attendees) {
    let id = a.email ? byEmail.get(a.email) : undefined;
    if (!id && a.name) {
      const ids = byName.get(normName(a.name)) ?? [];
      if (ids.length === 1) id = ids[0];
    }
    if (!id) continue;
    if (a.response === "declined") declined.add(id);
    else expected.add(id);
  }
  for (const id of expected) declined.delete(id);
  return { expected: [...expected].sort(), declined: [...declined].sort() };
}

/**
 * Guests the förening's people list doesn't know (the same matching as matchAttendees), with an
 * address and not declined: the growth loop's calendar-only guests (0067, meeting_calendar_guests).
 * Never the organiser's own row twice; one per address.
 */
export function unmatchedGuests(attendees: CalendarAttendee[], people: MatchPerson[], memberEmails: Map<string, string>): CalendarAttendee[] {
  const known = new Set<string>();
  for (const p of people) {
    for (const e of [p.email, p.member_user_id ? memberEmails.get(p.member_user_id) : null]) {
      if (e && e.includes("@")) known.add(e.trim().toLowerCase());
    }
  }
  const names = new Map<string, number>();
  for (const p of people) names.set(normName(p.name), (names.get(normName(p.name)) ?? 0) + 1);
  const out = new Map<string, CalendarAttendee>();
  for (const a of attendees) {
    if (!a.email || a.response === "declined" || known.has(a.email)) continue;
    // Matched by its exact full name (matchAttendees): that person, not a guest.
    if (a.name && names.get(normName(a.name)) === 1) continue;
    if (!out.has(a.email)) out.set(a.email, a);
  }
  return [...out.values()];
}

/** The stored form (meetings.calendar_event) read back, or null. */
export function parseMeetingEvent(raw: unknown): MeetingCalendarEvent | null {
  const r = raw as { title?: unknown; expected?: unknown; declined?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { title: cleanTitle(r.title), expected: ids(r.expected), declined: ids(r.declined) };
}

/** The `?kalender=` result the consent (or "Koppla från") returns with. */
export type CalendarResult = "ok" | "nej" | "fel" | "konto" | "fran";

export function calendarResult(raw: string | undefined): CalendarResult | undefined {
  return raw === "ok" || raw === "nej" || raw === "fel" || raw === "konto" || raw === "fran" ? raw : undefined;
}

/**
 * May a förening use this calendar? Only a shared (secondary) calendar, never a primary one
 * ('primary', or an e-mail address): every starter reads the förening's calendar with their own
 * grant, so a primary id would put each starter's private events into the shared Doc. Same rule
 * as the database check (0046).
 */
export function isOrgCalendarId(id: string): boolean {
  return id.length <= 300 && /^[^\s@/]+@group\.calendar\.google\.com$/.test(id);
}

/** The admin's calendars a förening may choose: shared ones only, never the primary. */
export function orgCalendarChoices(calendars: CalendarInfo[]): CalendarInfo[] {
  return calendars.filter((c) => !c.primary && isOrgCalendarId(c.id));
}
