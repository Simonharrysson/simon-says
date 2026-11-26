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
  isOrgCalendarId,
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

/** Google is slow to answer: give up (the caller treats it as "unavailable"). */
export class CalendarTimeoutError extends Error {
  constructor(what: string) {
    super(`calendar: ${what} timed out`);
    this.name = "CalendarTimeoutError";
  }
}

/** `p`, or CalendarTimeoutError after `ms` (the token refresh has no timeout of its own). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CalendarTimeoutError(what)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The token refresh's own limit. */
const REFRESH_TIMEOUT_MS = 3000;

export async function userCalendarApi(userId: string, timeoutMs = 5000): Promise<CalendarApi> {
  // Refreshes the access token once (getCalendarGoogleAuth); later getAccessToken calls are cached.
  const auth = await withTimeout(getCalendarGoogleAuth(userId), REFRESH_TIMEOUT_MS, "token refresh");
  return calendarApi({
    accessToken: async () => {
      const { token } = await withTimeout(auth.getAccessToken(), REFRESH_TIMEOUT_MS, "token");
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

// A short per-instance cache, so a förening page view doesn't call Google every time: per user and
// calendar (+ filter), 60 s. Holds titles and times only in memory, never written anywhere.
const CACHE_MS = 60_000;
const CACHE_MAX = 500;
type Cached<T> = { at: number; value: T };
const upcomingCache = new Map<string, Cached<CalendarEvent[]>>();
const calendarsCache = new Map<string, Cached<CalendarInfo[]>>();

function cached<T>(cache: Map<string, Cached<T>>, key: string, nowMs: number): T | undefined {
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  if (hit) cache.delete(key);
  return undefined;
}
function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, nowMs: number): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: nowMs, value });
}

/** Tests: start from an empty cache. */
export function clearCalendarCache(): void {
  upcomingCache.clear();
  calendarsCache.clear();
}

/**
 * The förening page's next meetings from its calendar, read with the viewer's own grant, cached
 * 60 s per (user, calendar). Only a shared calendar (isOrgCalendarId) is ever read.
 */
export async function orgUpcoming(userId: string, org: OrgCalendar, now = new Date()): Promise<UpcomingState> {
  if (!org.calendar_id || !isOrgCalendarId(org.calendar_id)) return { state: "none" };
  const key = `${userId}\u0000${org.calendar_id}`;
  const hit = cached(upcomingCache, key, now.getTime());
  if (hit) return { state: "ok", events: upcomingEvents(hit, now, org.calendar_filter) };
  try {
    const api = await userCalendarApi(userId, 3000);
    const from = new Date(now.getTime() - 6 * 3600_000);
    const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400_000);
    const events = await api.listEvents(org.calendar_id, from, to);
    remember(upcomingCache, key, events, now.getTime());
    return { state: "ok", events: upcomingEvents(events, now, org.calendar_filter) };
  } catch (err) {
    if (err instanceof CalendarAccessMissingError) return { state: "disconnected" };
    console.warn("calendar: upcoming unavailable", (err as Error)?.message);
    return { state: "unavailable" };
  }
}

/** The calendars the admin can choose from (their own list), cached 60 s unless `fresh`. Null: not connected or unreadable. */
export async function myCalendars(userId: string, opts: { fresh?: boolean } = {}): Promise<CalendarInfo[] | null> {
  const nowMs = Date.now();
  const hit = opts.fresh ? undefined : cached(calendarsCache, userId, nowMs);
  if (hit) return hit;
  try {
    const list = await (await userCalendarApi(userId, 3000)).listCalendars();
    remember(calendarsCache, userId, list, nowMs);
    return list;
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
  if (!org.calendar_id || !isOrgCalendarId(org.calendar_id)) return null;
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
  if (!org.calendar_id || !isOrgCalendarId(org.calendar_id) || !EVENT_ID.test(eventId)) return null;
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
