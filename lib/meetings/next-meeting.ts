import type { MeetingType } from "@/lib/prepare/types";

// The Möten tab's "Nästa möte" card (the weekly loop): one card at the top that changes state as the
// week goes by — not prepared → prepared → live → (notes being finished) → just ended. Pure: the
// förening and Företag pages feed it what they already read with the viewer's own client (RLS), so
// it never shows a meeting the viewer can't see.

/** A meeting as the page lists it (`listMeetings`, `loadForetagPage`), plus whether it is a Testmöte. */
export interface HeroMeeting {
  id: string;
  status: "live" | "ending" | "done" | "abandoned";
  started_at: string;
  ended_at: string | null;
  started_by: string | null;
  isTest?: boolean;
}

/** An upcoming prepared agenda (Förbered möte, 0033), soonest first. */
export interface HeroPrepared {
  /** Swedish local `YYYY-MM-DD`. */
  date: string;
  time: string | null;
  kind: MeetingType;
  docUrl: string;
}

/** An upcoming event of the förening's calendar (todo #14). */
export interface HeroEvent {
  id: string;
  title: string;
  /** Swedish local `YYYY-MM-DD` and `HH:MM`. */
  date: string;
  time: string;
  /** From 30 minutes before its start until its end. */
  now: boolean;
}

/** Which day a meeting is, for "Förbered tisdagens möte". */
export type HeroDay =
  | { type: "today" }
  | { type: "tomorrow" }
  /** Within the coming week: 0 = Sunday … 6 = Saturday. */
  | { type: "weekday"; weekday: number }
  | { type: "date"; date: string };

export type HeroState =
  /** A meeting is running: "Fortsätt mötet". */
  | { kind: "live"; meetingId: string }
  /** Avsluta was pressed; the final pass is writing the notes. */
  | { kind: "ending"; meetingId: string }
  /** Ended a little while ago: the recap and the way to its page. */
  | { kind: "ended"; meetingId: string }
  /** The next meeting has an agenda: "Starta mötet". */
  | { kind: "prepared"; prepared: HeroPrepared; event: HeroEvent | null; day: HeroDay }
  /** Nothing prepared: "Förbered <dag>ens möte" / "Starta utan förberedelse". `event` from the calendar when there is one. */
  | { kind: "unprepared"; event: HeroEvent | null; day: HeroDay | null }
  /** A Företag (no Förbered, no calendar here): just "Starta möte". */
  | { kind: "start" };

/** How long an ended meeting stays the card's subject (unless the next one is prepared already). */
export const JUST_ENDED_MS = 12 * 60 * 60 * 1000;

export interface HeroInput {
  meetings: HeroMeeting[];
  prepared: HeroPrepared[];
  /** The calendar's next events (soonest first), when the förening has a calendar and Google answered. */
  events?: HeroEvent[];
  now: Date;
  /** Swedish local today (`stockholmDay(now)`). */
  today: string;
  /** A förening: Förbered and the calendar exist. A Företag: only Starta. */
  canPrepare: boolean;
  /**
   * A Företag runs several meetings at once: only the viewer's own count (as `myLiveId`). Null: any
   * meeting of the förening (it runs one at a time).
   */
  onlyStartedBy?: string | null;
}

/** "YYYY-MM-DD" → days after `from` (both Swedish local days). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Which day `date` is, seen from `today`. */
export function heroDay(date: string, today: string): HeroDay {
  const d = daysBetween(today, date);
  if (d === 0) return { type: "today" };
  if (d === 1) return { type: "tomorrow" };
  if (d > 1 && d < 7) return { type: "weekday", weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
  return { type: "date", date };
}

/** Swedish local day of an instant. */
function stockholmDay(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The card's state. Precedence: live → ending → just ended → prepared → not prepared. */
export function nextMeetingState(input: HeroInput): HeroState {
  const { now, today } = input;
  const mine = (m: HeroMeeting) => input.onlyStartedBy == null || m.started_by === input.onlyStartedBy;
  const seen = input.meetings.filter(mine);

  const running = seen.filter((m) => m.status === "live" || m.status === "ending").sort((a, b) => b.started_at.localeCompare(a.started_at));
  const live = running.find((m) => m.status === "live");
  if (live) return { kind: "live", meetingId: live.id };
  if (running[0]) return { kind: "ending", meetingId: running[0].id };

  // The next prepared agenda (today or later), soonest first.
  const prepared = input.canPrepare ? (input.prepared.filter((p) => p.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null) : null;

  // Just ended: the newest finished real meeting, ended within the window (never "in the future").
  // A Testmöte never takes the card. Once the next meeting is prepared (a later day), that wins.
  const ended = seen
    .filter((m) => m.status === "done" && !m.isTest && m.ended_at)
    .sort((a, b) => b.ended_at!.localeCompare(a.ended_at!))[0];
  if (ended) {
    const age = now.getTime() - Date.parse(ended.ended_at!);
    const nextPrepared = prepared && prepared.date > stockholmDay(ended.ended_at!);
    if (age >= 0 && age <= JUST_ENDED_MS && !nextPrepared) return { kind: "ended", meetingId: ended.id };
  }

  if (!input.canPrepare) return { kind: "start" };

  const events = (input.events ?? []).filter((e) => e.date >= today).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const event = events[0] ?? null;
  // The calendar's next meeting comes before the prepared one: that is the next meeting, unprepared.
  if (prepared && (!event || prepared.date <= event.date)) {
    const same = events.find((e) => e.date === prepared.date) ?? null;
    return { kind: "prepared", prepared, event: same, day: heroDay(prepared.date, today) };
  }
  if (event) return { kind: "unprepared", event, day: heroDay(event.date, today) };
  return { kind: "unprepared", event: null, day: null };
}
