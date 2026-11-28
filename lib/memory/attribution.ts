import { meetingDayLabel } from "@/lib/home/tasks";
import type { MemoryLine } from "./memory";

// "Vad Claude ska veta": every line is an attributed statement that stays true however old it
// gets ("Sades i mötet 12 nov: kunden vill ha leverans i mars"), never a bare claim. Pure and
// client-safe: the settings page renders the parts (the date as a link to the meeting),
// get_org_memory the whole sentence.
//
// - a generated line: "Sades i mötet <date>" (the meeting it was said in; an older line, all its
//   source meetings: "Sades i mötena <date>, <date>"). Never a speaker's name: no note row is
//   tied to a confirmed speaker of that statement;
// - an admin's own or changed line: "Tillagt av <admin>" ("Tillagt av en admin" when not known).

export type Locale = "sv" | "en";

export type Attribution = { kind: "said"; meetingIds: string[] } | { kind: "admin"; by: string | null };

export function attributionOf(line: Pick<MemoryLine, "edited" | "sources" | "saidIn" | "addedBy">): Attribution {
  if (line.edited || line.sources.length === 0) return { kind: "admin", by: line.addedBy ?? null };
  if (line.saidIn && line.sources.includes(line.saidIn)) return { kind: "said", meetingIds: [line.saidIn] };
  return { kind: "said", meetingIds: line.sources };
}

export interface AttributionParts {
  /** The words before the meeting date(s): "Sades i mötet", "Tillagt av Anna". */
  lead: string;
  /** The meeting(s) it names, each with its date label ("12 nov"); empty for an admin's line. */
  meetings: { id: string; label: string }[];
}

const T = {
  sv: {
    said: (n: number) => (n === 1 ? "Sades i mötet" : "Sades i mötena"),
    admin: (who: string) => `Tillagt av ${who}`,
    adminUnknown: "Tillagt av en admin",
    someMeeting: "ett möte",
  },
  en: {
    said: (n: number) => (n === 1 ? "Said in the meeting on" : "Said in the meetings on"),
    admin: (who: string) => `Added by ${who}`,
    adminUnknown: "Added by an admin",
    someMeeting: "a meeting",
  },
} as const;

/**
 * The parts of a line's attribution. `dates`: YYYY-MM-DD per source meeting the reader can see
 * (the read filter already dropped a line with a source they can't).
 */
export function attributionParts(a: Attribution, dates: Record<string, string>, locale: Locale = "sv"): AttributionParts {
  const t = T[locale];
  const meeting = (id: string) => ({ id, label: dates[id] ? meetingDayLabel(dates[id], locale) : t.someMeeting });
  return a.kind === "admin"
    ? { lead: a.by ? t.admin(a.by) : t.adminUnknown, meetings: [] }
    : { lead: t.said(a.meetingIds.length), meetings: a.meetingIds.map(meeting) };
}

/** The attribution as plain text: "Sades i mötet 12 nov". */
export function attributionText(parts: AttributionParts): string {
  return parts.meetings.length ? `${parts.lead} ${parts.meetings.map((m) => m.label).join(", ")}` : parts.lead;
}

/** The whole line as an attributed statement: "Sades i mötet 12 nov: kunden vill ha leverans i mars". */
export function attributedLine(line: MemoryLine, dates: Record<string, string>, locale: Locale = "sv"): string {
  return `${attributionText(attributionParts(attributionOf(line), dates, locale))}: ${line.text}`;
}
