import "server-only";
import { orgMemberList } from "@/lib/db/members";
import { e2eGoogleRoot } from "@/lib/e2e/guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CalendarAccessMissingError, getCalendarGoogleAuth, hasCalendarAccess } from "@/lib/google/client";
import { calendarApi, type CalendarApi } from "./api";
import {
  eventForNow,
  matchAttendees,
  NOW_WINDOW_MS,
  upcomingEvents,
  type CalendarEvent,
  type CalendarInfo,
  type MatchPerson,
  type MeetingCalendarEvent,
} from "./events";

// The calendar connection on the server (todo #14). Every read uses the CALLER's own calendar
// grant (google_calendar_tokens), never another member's: a member sees the förening's calendar
// only if their own Google account can read it. Everything here is best effort: a calendar that
// can't be read hides the list, and never fails a page or a meeting start. Logs carry no titles,
// no guests and no calendar ids.

/** The förening's calendar settings (orgs, 0046). */
export interface OrgCalendar {
  calendar_id?: string | null;
  calendar_name?: string | null;
  calendar_filter?: string | null;
}

/** How far ahead the förening page looks. */
const LOOKAHEAD_DAYS = 60;

export async function userCalendarApi(userId: string, timeoutMs = 5000): Promise<CalendarApi> {
  const auth = await getCalendarGoogleAuth(userId);
  return calendarApi({
    accessToken: async () => {
      const { token } = await auth.getAccessToken();
      if (!token) throw new CalendarAccessMissingError(userId);
      return token;
    },
    root: e2eGoogleRoot(),
    timeoutMs,
  });
}

/** Is the user connected? A read failure counts as no. */
export async function safeCalendarConnected(userId: string): Promise<boolean> {
  try {
    return await hasCalendarAccess(userId);
  } catch (err) {
    console.error("calendar: connection unavailable", (err as Error)?.message);
    return false;
  }
}

export type UpcomingState =
  /** The förening has chosen no calendar. */
  | { state: "none" }
  /** It has; this user hasn't connected their calendar. */
  | { state: "disconnected" }
  /** Connected, but the calendar can't be read with this user's account (or Google is down). */
  | { state: "unavailable" }
  | { state: "ok"; events: CalendarEvent[] };

/** The förening page's next meetings from its calendar, read with the viewer's own grant. */
export async function orgUpcoming(userId: string, org: OrgCalendar, now = new Date()): Promise<UpcomingState> {
  if (!org.calendar_id) return { state: "none" };
  try {
    const api = await userCalendarApi(userId, 4000);
    const from = new Date(now.getTime() - 6 * 3600_000);
    const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400_000);
    return { state: "ok", events: upcomingEvents(await api.listEvents(org.calendar_id, from, to, 100), now, org.calendar_filter) };
  } catch (err) {
    if (err instanceof CalendarAccessMissingError) return { state: "disconnected" };
    console.warn("calendar: upcoming unavailable", (err as Error)?.message);
    return { state: "unavailable" };
  }
}

/** The calendars the admin can choose from (their own list). Null: not connected or unreadable. */
export async function myCalendars(userId: string): Promise<CalendarInfo[] | null> {
  try {
    return await (await userCalendarApi(userId, 4000)).listCalendars();
  } catch (err) {
    if (!(err instanceof CalendarAccessMissingError)) console.warn("calendar: list unavailable", (err as Error)?.message);
    return null;
  }
}

/**
 * The event a meeting starting now is, read with the STARTER's grant: the one picked on the
 * förening page (`eventId`, only if it is still "now"), else the filtered event happening now.
 * Its guests become ids of the förening's people. Null when there is none, or on any failure.
 */
export async function meetingEventForStart(input: {
  userId: string;
  org: OrgCalendar;
  eventId?: string | null;
  people: MatchPerson[];
  memberEmails: Map<string, string>;
  now?: Date;
  timeoutMs?: number;
}): Promise<MeetingCalendarEvent | null> {
  const { org } = input;
  if (!org.calendar_id) return null;
  const now = input.now ?? new Date();
  try {
    const api = await userCalendarApi(input.userId, input.timeoutMs ?? 3000);
    let event: CalendarEvent | null = null;
    if (input.eventId) {
      const picked = await api.getEvent(org.calendar_id, input.eventId);
      event = picked && eventForNow([picked], now, null) ? picked : null;
    }
    if (!event) {
      const from = new Date(now.getTime() - 12 * 3600_000);
      const to = new Date(now.getTime() + NOW_WINDOW_MS + 60_000);
      event = eventForNow(await api.listEvents(org.calendar_id, from, to, 50), now, org.calendar_filter);
    }
    if (!event) return null;
    return { title: event.title, ...matchAttendees(event.attendees, input.people, input.memberEmails) };
  } catch (err) {
    if (!(err instanceof CalendarAccessMissingError)) console.warn("calendar: start lookup failed", (err as Error)?.message);
    return null;
  }
}

/** One event of the förening's calendar (Förbered möte from the list), with the user's grant; null on any failure. */
export async function orgEvent(userId: string, org: OrgCalendar, eventId: string): Promise<CalendarEvent | null> {
  if (!org.calendar_id || !EVENT_ID.test(eventId)) return null;
  try {
    return await (await userCalendarApi(userId, 4000)).getEvent(org.calendar_id, eventId);
  } catch (err) {
    if (!(err instanceof CalendarAccessMissingError)) console.warn("calendar: event unavailable", (err as Error)?.message);
    return null;
  }
}

/** Google event ids (base32hex, plus "_" and a recurrence suffix): a sanity bound for URLs. */
export const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

/**
 * The start's calendar snapshot (todo #14): the förening's people and members (service role, the
 * caller has checked membership) and the event read with the starter's grant. Best effort: null on
 * any failure, and never longer than ~3 s.
 */
export async function calendarSnapshotForStart(input: {
  userId: string;
  org: OrgCalendar & { id: string };
  eventId?: string | null;
}): Promise<MeetingCalendarEvent | null> {
  if (!input.org.calendar_id) return null;
  try {
    const [people, members] = await Promise.all([
      supabaseAdmin().from("people").select("id, name, email, member_user_id").eq("org_id", input.org.id),
      orgMemberList(input.org.id),
    ]);
    if (people.error) throw new Error(people.error.message);
    return await meetingEventForStart({
      userId: input.userId,
      org: input.org,
      eventId: input.eventId && EVENT_ID.test(input.eventId) ? input.eventId : null,
      people: (people.data ?? []) as MatchPerson[],
      memberEmails: new Map(members.filter((m) => m.email).map((m) => [m.userId, m.email])),
    });
  } catch (err) {
    console.warn("calendar: start snapshot failed", (err as Error)?.message);
    return null;
  }
}
