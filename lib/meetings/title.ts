import { cleanTitle, parseMeetingEvent } from "@/lib/calendar/events";
import type { ItemRole } from "@/lib/db/types";

// A meeting's short title on the förening page (the meeting list's main line). Pure.
//
// Precedence (one place, so the list and anything else agree):
// 1. the calendar event the meeting matched at start (meetings.calendar_event, 0046): the förening named it;
// 2. the title Claude gave in the final notes pass (meetings.title, 0048);
// 3. the agenda's first topics (meetings.agenda_labels with role topic, 0028): "Ekonomi och spelkväll";
// 4. nothing: the list shows the date as the main line (old meetings, no Claude call to backfill).

/** Longest stored title (the column checks 80). */
export const MEETING_TITLE_MAX = 80;
/** A generated title is 2–6 words; anything longer is cut at this many. */
const MAX_WORDS = 8;
/** Agenda topics joined into a fallback title. */
const TOPICS_IN_TITLE = 2;

/**
 * Claude's title from the final pass, made safe to store: one line, no control characters, no
 * surrounding quotes or trailing full stop, at most 8 words and 80 characters. "" or non-text → null.
 */
export function cleanMeetingTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // One line, no control characters (the calendar title rules), then our own trimming.
  let t = cleanTitle(raw)
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/[.:;,]+$/, "")
    .trim();
  const words = t.split(" ");
  if (words.length > MAX_WORDS) t = words.slice(0, MAX_WORDS).join(" ");
  if (t.length > MEETING_TITLE_MAX) t = `${t.slice(0, MEETING_TITLE_MAX - 1).trimEnd()}…`;
  return t ? t : null;
}

export interface TitleSource {
  title?: string | null;
  calendar_event?: unknown;
  agenda_labels?: Record<string, string> | null;
  agenda_roles?: Record<string, ItemRole> | null;
}

const agendaNumber = (key: string) => Number(/^ag-(\d+)$/.exec(key)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** Lower-case a label's first letter when it is an ordinary word ("Spelkväll" → "spelkväll", "IT-frågor" stays). */
function midSentence(label: string): string {
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLocaleLowerCase("sv") + label.slice(1) : label;
}

/** "Ekonomi och spelkväll" from the agenda's first topic items (in agenda order), or null. */
export function agendaTitle(m: Pick<TitleSource, "agenda_labels" | "agenda_roles">, and: string): string | null {
  const topics = Object.entries(m.agenda_labels ?? {})
    .filter(([key, label]) => typeof label === "string" && label.trim() && (m.agenda_roles?.[key] ?? "topic") === "topic")
    .sort(([a], [b]) => agendaNumber(a) - agendaNumber(b))
    .slice(0, TOPICS_IN_TITLE)
    .map(([, label]) => label.trim());
  if (!topics.length) return null;
  const [first, ...rest] = topics;
  return cleanMeetingTitle([first, ...rest.map(midSentence)].join(` ${and} `));
}

/** The title the list shows, or null (then the date is the main line). `and`: the locale's "och"/"and". */
export function meetingTitle(m: TitleSource, and: string): string | null {
  const event = parseMeetingEvent(m.calendar_event)?.title;
  if (event) return cleanMeetingTitle(event);
  return cleanMeetingTitle(m.title) ?? agendaTitle(m, and);
}
