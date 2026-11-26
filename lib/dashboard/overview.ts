import type { ItemRole, MeetingStatus, NoteItemRow, PersonRow } from "@/lib/db/types";
import { normLabel } from "@/lib/agenda/scan";
import { isCopy, isDecision, isTask, type ChainItem } from "@/lib/meetings/summary";
import { resolveSpeaker } from "@/lib/segments/resolve";

// The org dashboard's views 1–4 ("Översikt" tab), pure over rows (decisions in
// docs/superpowers/specs/2026-11-26-org-dashboard-proposal.md, "Builder decisions"):
// - counted meetings: the org's, not a Testmöte, ended (done or abandoned);
// - open tasks: the tip of each carry chain, not done, grouped by person / owner;
// - decisions: newest first, with the agenda item's stored label;
// - recurring topics: topic labels in ≥ 2 counted meetings, decisions per month;
// - attendance: who was heard and named, per person.
// `loadOverview` (./load.ts) reads the rows with the caller's (RLS) client.

export interface DashMeeting {
  id: string;
  org_id: string;
  started_at: string;
  status: MeetingStatus;
  is_test?: boolean | null;
  agenda_roles?: Record<string, ItemRole> | null;
  agenda_labels?: Record<string, string> | null;
}

export type DashItem = ChainItem & Pick<NoteItemRow, "text" | "owner" | "due" | "position"> & Pick<Partial<NoteItemRow>, "anchor" | "owner_person_id">;

export interface DashSpeaker {
  meeting_id: string;
  el_session_id: string;
  speaker_label: string;
  person_id: string | null;
  display_name: string;
  merged_into_label?: string | null;
}

export type DashPerson = Pick<PersonRow, "id" | "name"> & { role?: string | null };

export interface DashInput {
  meetings: DashMeeting[];
  items: DashItem[];
  speakers: DashSpeaker[];
  people: DashPerson[];
}

export interface OpenTask {
  /** `<meetingId>:<itemId>` of the chain's tip (stable React key). */
  key: string;
  text: string;
  due: string | null;
  /** When the task was first written (the carry chain's first meeting). */
  since: string;
  /** Whole weeks since `since`. */
  weeks: number;
  /** Agenda item label of the first row, when stored. */
  item: string | null;
}

export interface TaskGroup {
  key: string;
  /** Person's name, the owner as written, or "Utan ansvarig". */
  label: string;
  role: string | null;
  tasks: OpenTask[];
}

export interface DecisionRow {
  key: string;
  text: string;
  date: string;
  item: string | null;
}

export interface TopicMonth {
  /** `YYYY-MM`. */
  month: string;
  decisions: string[];
}

export interface Topic {
  label: string;
  meetings: number;
  lastSeen: string;
  months: TopicMonth[];
}

export interface AttendanceRow {
  personId: string;
  name: string;
  attended: number;
  lastSeen: string | null;
}

export interface Attendance {
  /** Counted meetings where anyone was named: the denominator. */
  meetings: number;
  people: AttendanceRow[];
}

export interface Overview {
  meetingCount: number;
  firstMeeting: string | null;
  lastMeeting: string | null;
  openTasks: TaskGroup[];
  decisions: DecisionRow[];
  topics: Topic[];
  attendance: Attendance;
}

export const NO_OWNER = "Utan ansvarig";
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** Decisions shown: the last 12 months, newest first, at most this many. */
export const DECISION_LIMIT = 200;
const DECISION_WINDOW_MS = 365 * 24 * 3600 * 1000;
/** Roles that sit on every agenda and say nothing as topics. */
const NOT_TOPICS = new Set<ItemRole>(["procedural", "checkin", "followup", "other"]);
const key = (meetingId: string, id: string) => `${meetingId}\u0000${id}`;

/** The org's meetings the dashboard counts, oldest first. */
export function countedMeetings(orgId: string, meetings: DashMeeting[]): DashMeeting[] {
  return meetings
    .filter((m) => m.org_id === orgId && !m.is_test && (m.status === "done" || m.status === "abandoned"))
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/** The stored label of an item's anchor, unless the anchor is a Må-runda (or unknown). */
export function itemLabel(meeting: DashMeeting, anchor: string | null | undefined): string | null {
  if (!anchor) return null;
  if (meeting.agenda_roles?.[anchor] === "checkin") return null;
  const label = meeting.agenda_labels?.[anchor];
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

/** An item under the Må-runda: never shown, never sent anywhere (private part of the meeting). */
export const underCheckin = (meeting: DashMeeting, item: Pick<DashItem, "anchor">) =>
  Boolean(item.anchor && meeting.agenda_roles?.[item.anchor] === "checkin");

function scoped(orgId: string, input: DashInput) {
  const meetings = countedMeetings(orgId, input.meetings);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const items = input.items.filter((r) => {
    const m = byId.get(r.meeting_id);
    return m !== undefined && !underCheckin(m, r);
  });
  return { meetings, byId, items };
}

export function openTasks(orgId: string, input: DashInput, now: Date): TaskGroup[] {
  const { byId, items } = scoped(orgId, input);
  const doneCopies = new Set(items.filter((r) => isCopy(r) && r.done).map((r) => key(r.meeting_id, r.copy_of ?? r.id.slice(0, -2))));
  const tasks = items.filter(isTask);
  const byKey = new Map(tasks.map((r) => [key(r.meeting_id, r.id), r]));
  const carriedOn = new Set(
    tasks.filter((r) => r.carried_from_meeting && r.carried_from_id).map((r) => key(r.carried_from_meeting!, r.carried_from_id!)),
  );
  const people = new Map(input.people.map((p) => [p.id, p]));
  const groups = new Map<string, TaskGroup>();
  for (const tip of tasks) {
    const k = key(tip.meeting_id, tip.id);
    if (carriedOn.has(k) || tip.done || doneCopies.has(k)) continue;
    // Walk the chain back to where the task was first written.
    let first = tip;
    const seen = new Set([k]);
    while (first.carried_from_meeting && first.carried_from_id) {
      const prevKey = key(first.carried_from_meeting, first.carried_from_id);
      const prev = byKey.get(prevKey);
      if (!prev || seen.has(prevKey)) break;
      seen.add(prevKey);
      first = prev;
    }
    const firstMeeting = byId.get(first.meeting_id)!;
    const since = firstMeeting.started_at;
    const person = tip.owner_person_id ? people.get(tip.owner_person_id) : undefined;
    const owner = tip.owner?.trim() || null;
    const groupKey = person ? `p:${person.id}` : owner ? `o:${normLabel(owner)}` : "none";
    const group =
      groups.get(groupKey) ??
      { key: groupKey, label: person?.name ?? owner ?? NO_OWNER, role: person?.role?.trim() || null, tasks: [] };
    group.tasks.push({
      key: `${tip.meeting_id}:${tip.id}`,
      text: tip.text,
      due: tip.due,
      since,
      weeks: Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / WEEK_MS)),
      item: itemLabel(firstMeeting, first.anchor),
    });
    groups.set(groupKey, group);
  }
  const out = [...groups.values()];
  for (const g of out) g.tasks.sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  return out.sort(
    (a, b) =>
      Number(a.key === "none") - Number(b.key === "none") ||
      a.tasks[0].since.localeCompare(b.tasks[0].since) ||
      a.label.localeCompare(b.label, "sv"),
  );
}

export function recentDecisions(orgId: string, input: DashInput, now: Date, limit = DECISION_LIMIT): DecisionRow[] {
  const { byId, items } = scoped(orgId, input);
  const from = now.getTime() - DECISION_WINDOW_MS;
  return items
    .filter(isDecision)
    .map((r) => ({ r, m: byId.get(r.meeting_id)! }))
    .filter(({ m }) => Date.parse(m.started_at) >= from)
    .sort((a, b) => b.m.started_at.localeCompare(a.m.started_at) || a.r.position - b.r.position || a.r.id.localeCompare(b.r.id))
    .slice(0, limit)
    .map(({ r, m }) => ({ key: `${m.id}:${r.id}`, text: r.text, date: m.started_at, item: itemLabel(m, r.anchor) }));
}

export function recurringTopics(orgId: string, input: DashInput): Topic[] {
  const { meetings, byId, items } = scoped(orgId, input);
  const topics = new Map<string, { label: string; meetings: Set<string>; lastSeen: string; months: Map<string, string[]> }>();
  for (const m of meetings) {
    for (const [anchor, raw] of Object.entries(m.agenda_labels ?? {})) {
      const role = m.agenda_roles?.[anchor] ?? "topic";
      if (NOT_TOPICS.has(role) || typeof raw !== "string") continue;
      const n = normLabel(raw);
      if (!n) continue;
      const t = topics.get(n) ?? { label: raw.trim(), meetings: new Set<string>(), lastSeen: m.started_at, months: new Map() };
      t.meetings.add(m.id);
      // Newest spelling wins (meetings are oldest first).
      t.label = raw.trim();
      t.lastSeen = m.started_at;
      topics.set(n, t);
    }
  }
  const decisions = items
    .filter(isDecision)
    .sort((a, b) => byId.get(a.meeting_id)!.started_at.localeCompare(byId.get(b.meeting_id)!.started_at) || a.position - b.position);
  for (const r of decisions) {
    const m = byId.get(r.meeting_id)!;
    const label = itemLabel(m, r.anchor);
    const t = label ? topics.get(normLabel(label)) : undefined;
    if (!t) continue;
    const month = m.started_at.slice(0, 7);
    t.months.set(month, [...(t.months.get(month) ?? []), r.text]);
  }
  return [...topics.values()]
    .filter((t) => t.meetings.size >= 2)
    .map((t) => ({
      label: t.label,
      meetings: t.meetings.size,
      lastSeen: t.lastSeen,
      months: [...t.months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, decisions]) => ({ month, decisions })),
    }))
    .sort((a, b) => b.meetings - a.meetings || b.lastSeen.localeCompare(a.lastSeen) || a.label.localeCompare(b.label, "sv"));
}

export function attendance(orgId: string, input: DashInput): Attendance {
  const { meetings, byId } = scoped(orgId, input);
  const bySessionByMeeting = new Map<string, Map<string, DashSpeaker[]>>();
  for (const s of input.speakers) {
    if (!byId.has(s.meeting_id)) continue;
    const sessions = bySessionByMeeting.get(s.meeting_id) ?? new Map<string, DashSpeaker[]>();
    sessions.set(s.el_session_id, [...(sessions.get(s.el_session_id) ?? []), s]);
    bySessionByMeeting.set(s.meeting_id, sessions);
  }
  const people = new Map(input.people.map((p) => [p.id, p]));
  const rows = new Map<string, AttendanceRow>();
  let counted = 0;
  for (const m of meetings) {
    const present = new Set<string>();
    for (const rowsOfSession of bySessionByMeeting.get(m.id)?.values() ?? []) {
      for (const s of rowsOfSession) {
        const res = resolveSpeaker(rowsOfSession, s.speaker_label);
        if (res.personId && people.has(res.personId)) present.add(res.personId);
      }
    }
    if (!present.size) continue;
    counted++;
    for (const id of present) {
      const row = rows.get(id) ?? { personId: id, name: people.get(id)!.name, attended: 0, lastSeen: null };
      row.attended++;
      row.lastSeen = m.started_at;
      rows.set(id, row);
    }
  }
  // Everyone in the people list shows, also those never named.
  for (const p of input.people) if (!rows.has(p.id)) rows.set(p.id, { personId: p.id, name: p.name, attended: 0, lastSeen: null });
  return {
    meetings: counted,
    // By name, not by count: the list is for everyone to see, not a ranking.
    people: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "sv") || a.personId.localeCompare(b.personId)),
  };
}

export function buildOverview(orgId: string, input: DashInput, now: Date): Overview {
  const meetings = countedMeetings(orgId, input.meetings);
  return {
    meetingCount: meetings.length,
    firstMeeting: meetings[0]?.started_at ?? null,
    lastMeeting: meetings.at(-1)?.started_at ?? null,
    openTasks: openTasks(orgId, input, now),
    decisions: recentDecisions(orgId, input, now),
    topics: recurringTopics(orgId, input),
    attendance: attendance(orgId, input),
  };
}
