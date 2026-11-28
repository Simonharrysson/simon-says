import type { ItemRole } from "@/lib/db/types";
import { isDecision } from "@/lib/meetings/summary";
import { formatSaidAt } from "@/lib/notes/sources";
import {
  countsMeeting,
  isMine,
  myPersonIds,
  nextDay,
  taskTips,
  visible,
  type HomeMeeting,
  type HomeNoteRow,
  type HomePerson,
} from "@/lib/home/tasks";

// Inför möten (0059): what one brief says, from rows the caller already narrowed to the
// RECIPIENT's visibility (meetings: visible_meeting_ids, the RLS predicate; rows: only those
// meetings'). Pure. Every rule is the app's own (lib/home/tasks.ts): finished real meetings only,
// no Må-runda or info rows, nothing a human deleted, a carried task shown once as its latest copy,
// done on the row or its tasks copy, and a row a human edited (locked) keeps only its text.
// Never task_handoffs: a reviewed task from a meeting the recipient can't see must never be tied
// to a group or a customer (the handoff rule), so it has no place in a brief.

/** How many earlier meetings the brief looks at (newest first). */
export const BRIEF_MEETINGS = 30;
/** Decisions the mail shows. */
export const BRIEF_DECISIONS = 3;
/** Candidate decisions offered to the picker (newest first). */
export const DECISION_CANDIDATES = 30;
/** Open tasks listed before "… och N till". */
export const OPEN_MAX = 6;
/** Promised: open tasks whose deadline is past or within this many days. */
export const PROMISED_DAYS = 3;

export interface BriefMeetingRef {
  id: string;
  /** ISO start. */
  at: string;
  title: string | null;
  href: string;
}

export interface BriefDecision {
  /** Short id for the picker ("d1"). */
  key: string;
  text: string;
  meeting: BriefMeetingRef;
  /** 0069: where in the meeting it was said ("41:52"), only when the recipient may read that transcript. */
  saidAt?: string;
}

export interface BriefTask {
  text: string;
  /** Who, as written (or the linked person's name); null when nobody. */
  owner: string | null;
  mine: boolean;
  /** När, as said ("fredag"). */
  due: string | null;
  /** The deadline day (YYYY-MM-DD) when known. */
  dueDate: string | null;
  overdue: boolean;
  meeting: BriefMeetingRef;
}

export interface BriefAgenda {
  labels: string[];
  href: string;
}

export interface BriefContent {
  last: BriefMeetingRef | null;
  /** Every candidate decision, newest meeting first (the picker narrows to BRIEF_DECISIONS). */
  decisions: BriefDecision[];
  promised: BriefTask[];
  open: BriefTask[];
  /** Open tasks left out of `open` (shown as "… och N till"). */
  moreOpen: number;
  agenda: BriefAgenda | null;
}

export interface BriefInput {
  userId: string;
  orgId: string;
  /** Meetings the recipient can see (any order; filtered to finished real ones here). */
  meetings: HomeMeeting[];
  /** note_items of those meetings (sections action and decision); rows of other meetings are ignored. */
  rows: HomeNoteRow[];
  /** The org's people (for "mine" and owner names). */
  people: HomePerson[];
  agenda: BriefAgenda | null;
  /** 0069: meetings whose transcript the recipient may read; other meetings' decisions get no time. */
  transcriptMeetings?: string[];
  /** Today in Stockholm (YYYY-MM-DD). */
  today: string;
  /** The in-app meeting page of a meeting. */
  meetingHref: (meetingId: string) => string;
}

const clean = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim() || null;

/** `day` plus `n` days (YYYY-MM-DD). */
function addDays(day: string, n: number): string {
  let d = day;
  for (let i = 0; i < n; i++) d = nextDay(d);
  return d;
}

/** The brief's content, or null when there is nothing relevant (no history and no agenda: no mail). */
export function briefContent(input: BriefInput): BriefContent | null {
  const meetings = input.meetings
    .filter((m) => m.org_id === input.orgId && countsMeeting(m))
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id))
    .slice(0, BRIEF_MEETINGS);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const ref = (m: HomeMeeting): BriefMeetingRef => ({ id: m.id, at: m.started_at, title: clean(m.title), href: input.meetingHref(m.id) });
  const rows = input.rows.filter((r) => byId.has(r.meeting_id));
  const rolesOf = (meetingId: string) => (byId.get(meetingId)?.agenda_roles ?? {}) as Record<string, ItemRole>;
  const order = new Map(meetings.map((m, i) => [m.id, i]));
  const transcripts = new Set(input.transcriptMeetings ?? []);

  const decisions: BriefDecision[] = rows
    .filter((r) => visible(r, rolesOf(r.meeting_id)))
    .filter((r) => isDecision({ ...r, kind: r.kind ?? null, done: r.done ?? false, copy_of: r.copy_of ?? null, carried_from_meeting: r.carried_from_meeting ?? null, carried_from_id: r.carried_from_id ?? null }))
    .sort((a, b) => order.get(a.meeting_id)! - order.get(b.meeting_id)! || a.position - b.position)
    .slice(0, DECISION_CANDIDATES)
    .map((r, i) => ({
      key: `d${i + 1}`,
      text: clean(r.text)!,
      meeting: ref(byId.get(r.meeting_id)!),
      ...(transcripts.has(r.meeting_id) && r.source_segment_ids?.length && typeof r.said_at_ms === "number" ? { saidAt: formatSaidAt(Number(r.said_at_ms)) } : {}),
    }));

  const orgPeople = input.people.filter((p) => p.org_id === input.orgId);
  const names = new Map(orgPeople.map((p) => [p.id, p.name]));
  const mine = myPersonIds(input.people, input.orgId, input.userId);
  const soon = addDays(input.today, PROMISED_DAYS);
  const tasks: BriefTask[] = taskTips(rows, meetings)
    .filter((r) => !r.done)
    .map((r) => {
      const dueDate = r.due_date ?? null;
      return {
        text: clean(r.text)!,
        // A row a human edited keeps only their text (lib/home/tasks.ts): its owner and När are not ours to show.
        owner: r.locked ? null : (clean(r.owner) ?? (r.owner_person_id ? (names.get(r.owner_person_id) ?? null) : null)),
        mine: isMine(r, orgPeople, mine),
        due: r.locked ? null : clean(r.due),
        dueDate,
        overdue: Boolean(dueDate && dueDate < input.today),
        meeting: ref(byId.get(r.meeting_id)!),
      };
    });
  const promised = tasks
    .filter((t) => t.dueDate && t.dueDate <= soon)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || Number(b.mine) - Number(a.mine) || b.meeting.at.localeCompare(a.meeting.at));
  const rest = tasks
    .filter((t) => !(t.dueDate && t.dueDate <= soon))
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) ||
        (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : 0) ||
        b.meeting.at.localeCompare(a.meeting.at),
    );

  const last = meetings[0] ? ref(meetings[0]) : null;
  if (!last && !input.agenda) return null;
  return { last, decisions, promised, open: rest.slice(0, OPEN_MAX), moreOpen: Math.max(0, rest.length - OPEN_MAX), agenda: input.agenda };
}

/** The decisions to show: the picked keys (validated, in the picker's order), filled up with the newest. */
export function chooseDecisions(all: BriefDecision[], picked: string[] | null, max = BRIEF_DECISIONS): BriefDecision[] {
  const byKey = new Map(all.map((d) => [d.key, d]));
  const out: BriefDecision[] = [];
  for (const k of picked ?? []) {
    const d = byKey.get(k);
    if (d && !out.includes(d)) out.push(d);
    if (out.length === max) return out;
  }
  for (const d of all) {
    if (out.length === max) break;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** The prepared agenda's points as shown (the ticked items' labels, in order), at most `max`. */
export function agendaLabels(items: unknown, max = 8): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is { label: string; on?: unknown } => Boolean(i) && typeof (i as { label?: unknown }).label === "string")
    .filter((i) => i.on !== false)
    .map((i) => clean(i.label))
    .filter((l): l is string => Boolean(l))
    .slice(0, max);
}

/** How far a prepared agenda's time may be from the event's start and still be its agenda. */
export const AGENDA_TIME_SLACK_MIN = 120;

const minutes = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The prepared agenda for an event (same day): the one whose time is closest to the event's start
 * (HH:MM, Stockholm), within two hours; one without a time only when no timed one fits.
 */
export function pickAgenda<T extends { meeting_time: string | null }>(rows: T[], eventTime: string): T | null {
  const at = minutes(eventTime);
  let best: { row: T; diff: number } | null = null;
  for (const row of rows) {
    const t = row.meeting_time ? minutes(row.meeting_time) : null;
    if (t === null || at === null) continue;
    const diff = Math.abs(t - at);
    if (diff <= AGENDA_TIME_SLACK_MIN && (!best || diff < best.diff)) best = { row, diff };
  }
  return best?.row ?? rows.find((r) => !r.meeting_time) ?? null;
}
