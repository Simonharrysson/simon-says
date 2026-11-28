import { meetingDayLabel } from "@/lib/home/tasks";
import type { MemoryLine } from "./memory";

// "Vad Claude ska veta": every line is an attributed statement that stays true however old it
// gets ("Anna Svensson sa i mötet 12 nov: kunden vill ha leverans i mars"), never a bare claim.
// Pure and client-safe: the settings page renders the parts (the date as a link to the meeting),
// get_org_memory the whole sentence.
//
// - attributed (generated since 2026-11-28): "<speaker> sa i mötet <date>" when the server could
//   tie it to a person (a task owner of that meeting), else "Sades i mötet <date>";
// - an admin's own or changed line: "Tillagt av <admin>" ("Tillagt av en admin" when not known);
// - an older generated line: "Från mötet <date>" (its source meetings).

export type Locale = "sv" | "en";

export type Attribution =
  | { kind: "said"; speaker: string | null; meetingId: string }
  | { kind: "admin"; by: string | null }
  | { kind: "legacy"; meetingIds: string[] };

export function attributionOf(line: Pick<MemoryLine, "edited" | "sources" | "saidIn" | "speaker" | "addedBy">): Attribution {
  if (line.edited || line.sources.length === 0) return { kind: "admin", by: line.addedBy ?? null };
  if (line.saidIn && line.sources.includes(line.saidIn)) return { kind: "said", speaker: line.speaker ?? null, meetingId: line.saidIn };
  return { kind: "legacy", meetingIds: line.sources };
}

export interface AttributionParts {
  /** The words before the meeting date(s): "Anna Svensson sa i mötet", "Tillagt av Anna". */
  lead: string;
  /** The meeting(s) it names, each with its date label ("12 nov"); empty for an admin's line. */
  meetings: { id: string; label: string }[];
}

const T = {
  sv: {
    said: (who: string) => `${who} sa i mötet`,
    saidUnknown: "Sades i mötet",
    legacy: (n: number) => (n === 1 ? "Från mötet" : "Från mötena"),
    admin: (who: string) => `Tillagt av ${who}`,
    adminUnknown: "Tillagt av en admin",
    someMeeting: "ett möte",
  },
  en: {
    said: (who: string) => `${who} said in the meeting on`,
    saidUnknown: "Said in the meeting on",
    legacy: (n: number) => (n === 1 ? "From the meeting on" : "From the meetings on"),
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
  switch (a.kind) {
    case "admin":
      return { lead: a.by ? t.admin(a.by) : t.adminUnknown, meetings: [] };
    case "said":
      return { lead: a.speaker ? t.said(a.speaker) : t.saidUnknown, meetings: [meeting(a.meetingId)] };
    case "legacy":
      return { lead: t.legacy(a.meetingIds.length), meetings: a.meetingIds.map(meeting) };
  }
}

/** The attribution as plain text: "Anna Svensson sa i mötet 12 nov". */
export function attributionText(parts: AttributionParts): string {
  return parts.meetings.length ? `${parts.lead} ${parts.meetings.map((m) => m.label).join(", ")}` : parts.lead;
}

/** The whole line as an attributed statement: "Anna Svensson sa i mötet 12 nov: kunden vill ha leverans i mars". */
export function attributedLine(line: MemoryLine, dates: Record<string, string>, locale: Locale = "sv"): string {
  return `${attributionText(attributionParts(attributionOf(line), dates, locale))}: ${line.text}`;
}
