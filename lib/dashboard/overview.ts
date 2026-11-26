import type { ItemRole, MeetingStatus, NoteItemRow, PersonRow } from "@/lib/db/types";
import { normLabel } from "@/lib/agenda/scan";
import { isCopy, isDecision, isTask, type ChainItem } from "@/lib/meetings/summary";
import type { HistoryItem, HistoryMeeting } from "@/lib/history/types";
import { synonymRole } from "@/lib/agenda/role-words";

// The org dashboard's pure helpers, over rows (decisions in
// docs/superpowers/specs/2026-11-26-org-dashboard-proposal.md, "Builder decisions"). The Översikt
// tab itself only shows the goals (Mål) and a line about what they build on; the rest is shared:
// - counted meetings: the org's, not a Testmöte, ended (done or abandoned);
// - open tasks: the tip of each carry chain, not done (the goals digest);
// - recurring topics: topic labels in ≥ 2 counted meetings (Förbered möte, the goals digest).
// Imported old protocols (lib/history, 0032) count in the recurring topics. Their items were
// name-scrubbed when stored.

export interface DashMeeting {
  id: string;
  org_id: string;
  started_at: string;
  status: MeetingStatus;
  is_test?: boolean | null;
  /** Only "format" meetings carry and close tasks (lib/agenda/followup). */
  layout?: "v1" | "format" | null;
  agenda_roles?: Record<string, ItemRole> | null;
  agenda_labels?: Record<string, string> | null;
}

export type DashItem = ChainItem & Pick<NoteItemRow, "text" | "owner" | "due" | "position"> & Pick<Partial<NoteItemRow>, "anchor" | "owner_person_id">;

export type DashPerson = Pick<PersonRow, "id" | "name"> & { role?: string | null };

export interface DashInput {
  meetings: DashMeeting[];
  items: DashItem[];
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

/** What the Översikt's basis line needs: own counted meetings and the imported protocols. */
export interface Overview {
  meetingCount: number;
  firstMeeting: string | null;
  /** Imported old protocols: how many, and the first and last date (YYYY-MM-DD). */
  imported: ImportedSummary;
}

export interface ImportedSummary {
  count: number;
  first: string | null;
  last: string | null;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
export const NO_OWNER = "Utan ansvarig";
const key = (meetingId: string, id: string) => `${meetingId}\u0000${id}`;
/** Roles that sit on every agenda and say nothing as topics. */
const NOT_TOPICS = new Set<ItemRole>(["procedural", "checkin", "followup", "other"]);

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

/**
 * Tasks only from meetings that take part in carrying (lib/agenda/followup): status done (an
 * abandoned false start is never a carry source, and its rows may be adopted by the next start on
 * the same Doc, so they would show twice) and the format layout (v1-layout tasks are never carried
 * or closed, so all of them would look open forever).
 */
const carriesTasks = (m: DashMeeting) => m.status === "done" && m.layout === "format";

export function openTasks(orgId: string, input: DashInput, now: Date): TaskGroup[] {
  const scope = scoped(orgId, input);
  const byId = new Map([...scope.byId].filter(([, m]) => carriesTasks(m)));
  const items = scope.items.filter((r) => byId.has(r.meeting_id));
  const doneCopies = new Set(items.filter((r) => isCopy(r) && r.done).map((r) => key(r.meeting_id, r.copy_of ?? r.id.slice(0, -2))));
  const tasks = items.filter(isTask);
  const byKey = new Map(tasks.map((r) => [key(r.meeting_id, r.id), r]));
  // Every carried primary row, a deleted one too: a human deleting the carried line closes the task.
  const carriedOn = new Set(
    items
      .filter((r) => !isCopy(r) && r.carried_from_meeting && r.carried_from_id)
      .map((r) => key(r.carried_from_meeting!, r.carried_from_id!)),
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

/** An imported protocol's date (YYYY-MM-DD) as a timestamp: midday UTC, the same day in Stockholm. */
export const importedAt = (date: string) => `${date.slice(0, 10)}T12:00:00Z`;

const monthOf = (iso: string) => iso.slice(0, 7);
const cleanLabel = (s: string | null | undefined) => (typeof s === "string" && s.trim() ? s.trim() : null);

/** Imported protocols carry no roles: a label's words say whether it is a formality or a check-in. */
const importedTopic = (label: string | null | undefined) => {
  const l = cleanLabel(label);
  return l && !synonymRole(l) ? l : null;
};
/** An imported line under a Må-runda: never shown, like the own meetings' (`underCheckin`). */
const importedUnderCheckin = (i: Pick<HistoryItem, "topic">) => Boolean(i.topic && synonymRole(i.topic) === "checkin");

/**
 * Topic labels on the agenda of ≥ 2 meetings, own and imported (an imported protocol's topics: its
 * topic lines and the topics its other lines sit under), with the decisions under each per month.
 */
export function recurringTopics(orgId: string, input: DashInput, imported: HistoryMeeting[] = []): Topic[] {
  const { meetings, byId, items } = scoped(orgId, input);
  // Every meeting as (id, when, labels, decisions), oldest first.
  type Source = { id: string; at: string; labels: string[]; decisions: { label: string | null; text: string; order: number }[] };
  const sources: Source[] = [];
  const decisionsOf = new Map<string, Source["decisions"]>();
  for (const m of meetings) {
    const labels = Object.entries(m.agenda_labels ?? {})
      .filter(([anchor, raw]) => !NOT_TOPICS.has(m.agenda_roles?.[anchor] ?? "topic") && typeof raw === "string")
      .map(([, raw]) => raw as string);
    const src: Source = { id: m.id, at: m.started_at, labels, decisions: [] };
    decisionsOf.set(m.id, src.decisions);
    sources.push(src);
  }
  for (const r of items.filter(isDecision)) decisionsOf.get(r.meeting_id)!.push({ label: itemLabel(byId.get(r.meeting_id)!, r.anchor), text: r.text, order: r.position });
  imported.forEach((m, p) => {
    const labels = m.items.map((i) => importedTopic(i.kind === "topic" ? i.text : i.topic)).filter((l): l is string => l !== null);
    const decisions = m.items.flatMap((i, k) => (i.kind === "decision" && !importedUnderCheckin(i) ? [{ label: importedTopic(i.topic), text: i.text, order: k }] : []));
    sources.push({ id: `import:${p}`, at: importedAt(m.date), labels, decisions });
  });
  sources.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));

  const topics = new Map<string, { label: string; meetings: Set<string>; lastSeen: string; months: Map<string, string[]> }>();
  for (const src of sources) {
    for (const raw of src.labels) {
      const n = normLabel(raw);
      if (!n) continue;
      const t = topics.get(n) ?? { label: raw.trim(), meetings: new Set<string>(), lastSeen: src.at, months: new Map() };
      t.meetings.add(src.id);
      // Newest spelling wins (oldest first).
      t.label = raw.trim();
      t.lastSeen = src.at;
      topics.set(n, t);
    }
  }
  for (const src of sources) {
    for (const d of [...src.decisions].sort((a, b) => a.order - b.order)) {
      const t = d.label ? topics.get(normLabel(d.label)) : undefined;
      if (!t) continue;
      const month = monthOf(src.at);
      t.months.set(month, [...(t.months.get(month) ?? []), d.text]);
    }
  }
  return [...topics.values()]
    .filter((t) => t.meetings.size >= 2)
    .map((t) => ({
      label: t.label,
      meetings: t.meetings.size,
      lastSeen: t.lastSeen,
      months: [...t.months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, decisions]) => ({ month, decisions })),
    }))
    .sort((a, b) => b.meetings - a.meetings || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.label.localeCompare(b.label, "sv"));
}

/** What the Översikt says about imported protocols. */
export function importedSummary(imported: HistoryMeeting[]): ImportedSummary {
  const dates = imported.map((m) => m.date.slice(0, 10)).sort();
  return { count: imported.length, first: dates[0] ?? null, last: dates.at(-1) ?? null };
}

export function buildOverview(orgId: string, meetings: DashMeeting[], imported: HistoryMeeting[] = []): Overview {
  const counted = countedMeetings(orgId, meetings);
  return { meetingCount: counted.length, firstMeeting: counted[0]?.started_at ?? null, imported: importedSummary(imported) };
}
