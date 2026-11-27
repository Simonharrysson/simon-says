import { createHash } from "node:crypto";
import type { CalendarEvent } from "@/lib/calendar/events";
import { domainOf } from "@/lib/foretag/customers";

// Inför möten (0059): when a brief goes out, and the sent-log's key. Pure.
//
// The cron runs every 5 minutes. A brief goes out on the first run that sees the meeting start
// within the next 15 minutes (so about 10–15 minutes before; a run that slips still catches it on
// the next one), never once it has started. The sent-log (one row per user and event) makes every
// later run a no-op, so the window may overlap runs freely.

/** Latest lead time: a meeting starting later than this waits for a later run. */
export const BRIEF_LEAD_MS = 15 * 60_000;

/** Is it time for this event's brief? (0 < start − now ≤ 15 min.) */
export function inBriefWindow(event: Pick<CalendarEvent, "start">, now: Date): boolean {
  const lead = Date.parse(event.start) - now.getTime();
  return Number.isFinite(lead) && lead > 0 && lead <= BRIEF_LEAD_MS;
}

/**
 * The sent-log key: a hash of the Google event id (never the id, title or guests themselves). The
 * same meeting seen on a förening's shared calendar and in the user's own calendar has one id at
 * Google, so it gets one brief.
 */
export function briefEventKey(eventId: string): string {
  return createHash("sha256").update(`simon-says brief v1\u0000${eventId}`).digest("hex");
}

/** Did this user decline the event (their own address on its guest list)? */
export function declinedBy(event: Pick<CalendarEvent, "attendees">, emails: string[]): boolean {
  const mine = new Set(emails.map((e) => e.trim().toLowerCase()));
  return event.attendees.some((a) => a.email && mine.has(a.email) && a.response === "declined");
}

/** The guests' addresses outside the user's own ones (for the customer's domain). */
export function guestEmails(event: Pick<CalendarEvent, "attendees">, own: string[]): string[] {
  const mine = new Set(own.map((e) => e.trim().toLowerCase()));
  return event.attendees.flatMap((a) => (a.email && !mine.has(a.email) && a.response !== "declined" && domainOf(a.email) ? [a.email] : []));
}
