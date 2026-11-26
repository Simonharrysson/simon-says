import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { isCopy, isDecision, isTask } from "@/lib/meetings/summary";
import { resolveOwner, type RolePerson } from "@/lib/people/roles";

// "Mina uppgifter" (the home page, /hem): the signed-in user's open tasks across every förening
// and Privat. Pure over rows the loader reads with the user's own client (RLS: only spaces the user
// is a member of), so this never widens what membership already shows.
//
// Rules:
// - a förening task is mine when its owner is a person linked to me (people.member_user_id): by
//   owner_person_id, or the owner text naming that person by name, first name or role (the same
//   rule as the summary e-mail's "your tasks", lib/summaries/content.ts);
// - a Privat task is mine when it has no other owner (the summary's "Mina uppgifter");
// - only finished, real meetings (status done, not a Testmöte): a live meeting's rows are still
//   being written by its tick;
// - a task carried on to a later meeting ("Från förra veckan") is shown once, as its latest copy;
// - a task is done on its row or on its tasks-section copy (`<id>-t`, "✓ klart");
// - never a Må-runda row (private to the meeting) or an info cell, never one a human deleted.

export type SpaceKind = "forening" | "privat";

export interface HomeSpace {
  id: string;
  name: string;
  kind: SpaceKind;
  /** The user is an admin of this förening (may tick anyone's task). */
  isAdmin: boolean;
}

export interface HomePerson extends RolePerson {
  org_id: string;
  member_user_id: string | null;
}

export interface HomeMeeting {
  id: string;
  org_id: string;
  started_at: string;
  status: string;
  is_test?: boolean | null;
  doc_id?: string | null;
  context_id?: string | null;
  agenda_roles?: Record<string, ItemRole> | null;
  /** meetings.title (0048), when the column exists and is set. */
  title?: string | null;
}

/** A note row as read with `select("*")`: the concrete-tasks columns (0047) when present. */
export type HomeNoteRow = NoteItemRow & { due_date?: string | null; done_when?: string | null };

export interface PrivatTaskRow {
  id: string;
  context_id: string;
  meeting_id: string;
  text: string;
  owner: string | null;
  done: boolean;
  done_at?: string | null;
  created_at: string;
  position?: number;
}

export interface MyTask {
  /** "n:<meetingId>:<itemId>" (förening) or "p:<taskId>" (Privat). */
  key: string;
  kind: "note" | "privat";
  spaceId: string;
  spaceName: string;
  spaceKind: SpaceKind;
  meetingId: string;
  /** note_items.id (förening) or context_tasks.id (Privat). */
  itemId: string;
  text: string;
  /** The deadline as said ("fredag", "4 dec"), when there is one. */
  due: string | null;
  /** The deadline as a day (YYYY-MM-DD), when it names one (0047). */
  dueDate: string | null;
  /** "Klart när" (0047). */
  doneWhen: string | null;
  /** Privat: the context's name ("TDDE15"). */
  contextName: string | null;
  done: boolean;
  /** Start of the meeting the task came from. */
  meetingAt: string;
  position: number;
}

const key = (meetingId: string, id: string) => `${meetingId}\u0000${id}`;
const trimmed = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim() || null;

/** Rows a task list may show at all (no Må-runda, no info cells, nothing deleted, not empty). */
function visible(r: HomeNoteRow, roles: Record<string, ItemRole>): boolean {
  if (r.deleted_by_human) return false;
  if (r.anchor && (roles[r.anchor] === "checkin" || r.anchor.startsWith("info."))) return false;
  return Boolean(trimmed(r.text));
}

/** The ids of the people in `orgId` linked to `userId`. */
export function myPersonIds(people: HomePerson[], orgId: string, userId: string): Set<string> {
  return new Set(people.filter((p) => p.org_id === orgId && p.member_user_id === userId).map((p) => p.id));
}

/** Is this förening task the user's: by its owner link, or its owner text naming a person linked to them. */
export function isMine(row: Pick<NoteItemRow, "owner" | "owner_person_id">, orgPeople: RolePerson[], mine: Set<string>): boolean {
  if (!mine.size) return false;
  if (row.owner_person_id && mine.has(row.owner_person_id)) return true;
  if (!row.owner) return false;
  const person = resolveOwner(row.owner, orgPeople);
  return person ? mine.has(person.id) : false;
}

/** Who may mark a förening task done: its owner, or an admin of the förening. */
export function canTick(input: { mine: boolean; isAdmin: boolean }): boolean {
  return input.mine || input.isAdmin;
}

/** Finished, real meetings of a förening (the only ones whose tasks are listed). */
export const countsMeeting = (m: Pick<HomeMeeting, "status" | "is_test">) => m.status === "done" && !m.is_test;

/**
 * The open (and, with `includeDone`, done) task rows of a set of meetings, each shown once: a row
 * that a later meeting carried on is left out (its carried copy stands for it), copies too.
 * `done` on the result: on the row or its tasks copy.
 */
export function taskTips(rows: HomeNoteRow[], meetings: HomeMeeting[]): (HomeNoteRow & { done: boolean })[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const counted = rows.filter((r) => {
    const m = byId.get(r.meeting_id);
    return m && countsMeeting(m);
  });
  const doneCopies = new Set(counted.filter((r) => isCopy(r) && r.done).map((r) => key(r.meeting_id, r.copy_of ?? r.id.slice(0, -2))));
  const tasks = counted.filter((r) => isTask({ ...r, kind: r.kind ?? null, done: r.done ?? false, copy_of: r.copy_of ?? null, carried_from_meeting: r.carried_from_meeting ?? null, carried_from_id: r.carried_from_id ?? null }));
  const carriedOn = new Set(
    tasks.filter((r) => r.carried_from_meeting && r.carried_from_id != null).map((r) => key(r.carried_from_meeting!, r.carried_from_id!)),
  );
  return tasks
    .filter((r) => !carriedOn.has(key(r.meeting_id, r.id)) && visible(r, byId.get(r.meeting_id)?.agenda_roles ?? {}))
    .map((r) => ({ ...r, done: Boolean(r.done) || doneCopies.has(key(r.meeting_id, r.id)) }));
}

/** The user's tasks in the föreningar (not Privat). */
export function myForeningTasks(input: {
  userId: string;
  spaces: HomeSpace[];
  meetings: HomeMeeting[];
  rows: HomeNoteRow[];
  people: HomePerson[];
}): MyTask[] {
  const spaces = new Map(input.spaces.filter((s) => s.kind === "forening").map((s) => [s.id, s]));
  const meetings = input.meetings.filter((m) => spaces.has(m.org_id));
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const out: MyTask[] = [];
  for (const r of taskTips(input.rows, meetings)) {
    const m = byId.get(r.meeting_id)!;
    const space = spaces.get(m.org_id)!;
    const orgPeople = input.people.filter((p) => p.org_id === m.org_id);
    if (!isMine(r, orgPeople, myPersonIds(input.people, m.org_id, input.userId))) continue;
    // A row a human edited keeps only their text (owner and due are not ours to show then).
    out.push({
      key: `n:${r.meeting_id}:${r.id}`,
      kind: "note",
      spaceId: space.id,
      spaceName: space.name,
      spaceKind: "forening",
      meetingId: r.meeting_id,
      itemId: r.id,
      text: trimmed(r.text)!,
      due: r.locked ? null : trimmed(r.due),
      dueDate: r.due_date ?? null,
      doneWhen: r.locked ? null : trimmed(r.done_when),
      contextName: null,
      done: r.done,
      meetingAt: m.started_at,
      position: r.position,
    });
  }
  return out;
}

/** The user's Privat tasks: those without another owner. */
export function myPrivatTasks(input: {
  space: HomeSpace | null;
  tasks: PrivatTaskRow[];
  contexts: { id: string; name: string }[];
  meetings: Pick<HomeMeeting, "id" | "started_at">[];
}): MyTask[] {
  const space = input.space;
  if (!space) return [];
  const contexts = new Map(input.contexts.map((c) => [c.id, c.name]));
  const startedAt = new Map(input.meetings.map((m) => [m.id, m.started_at]));
  return input.tasks
    .filter((t) => !trimmed(t.owner) && trimmed(t.text))
    .map((t) => ({
      key: `p:${t.id}`,
      kind: "privat" as const,
      spaceId: space.id,
      spaceName: space.name,
      spaceKind: "privat" as const,
      meetingId: t.meeting_id,
      itemId: t.id,
      text: trimmed(t.text)!,
      due: null,
      dueDate: null,
      doneWhen: null,
      contextName: contexts.get(t.context_id) ?? null,
      done: t.done,
      meetingAt: startedAt.get(t.meeting_id) ?? t.created_at,
      position: t.position ?? 0,
    }));
}

/** Deadline first (a day before none), then the newest meeting, then the order in the meeting. */
export function sortTasks<T extends Pick<MyTask, "dueDate" | "meetingAt" | "position" | "key">>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) ||
      (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : 0) ||
      b.meetingAt.localeCompare(a.meetingAt) ||
      a.position - b.position ||
      a.key.localeCompare(b.key),
  );
}

/** The calendar day (YYYY-MM-DD) of an instant in Stockholm. */
export function stockholmDay(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** A deadline day before `today` (both YYYY-MM-DD) on a task that is still open. */
export function isOverdue(task: Pick<MyTask, "dueDate" | "done">, today: string): boolean {
  return !task.done && Boolean(task.dueDate) && task.dueDate! < today;
}

export interface RecentMeeting {
  id: string;
  spaceId: string;
  spaceName: string;
  spaceKind: SpaceKind;
  startedAt: string;
  /** meetings.title, or the Privat context's name; null: the page shows the date. */
  title: string | null;
  decisions: number;
  tasks: number;
  /** The in-app meeting page. */
  href: string;
}

/** Decisions and tasks one förening meeting wrote (copies, deleted rows and Må-runda rows left out). */
export function meetingCounts(rows: HomeNoteRow[], roles: Record<string, ItemRole> = {}): { decisions: number; tasks: number } {
  let decisions = 0;
  let tasks = 0;
  for (const r of rows) {
    if (!visible(r, roles)) continue;
    const chain = { ...r, kind: r.kind ?? null, done: r.done ?? false, copy_of: r.copy_of ?? null, carried_from_meeting: r.carried_from_meeting ?? null, carried_from_id: r.carried_from_id ?? null };
    if (isDecision(chain)) decisions++;
    else if (isTask(chain)) tasks++;
  }
  return { decisions, tasks };
}

const TZ = "Europe/Stockholm";
const tag = (locale: "sv" | "en") => (locale === "en" ? "en-GB" : "sv-SE");

/** A deadline day (YYYY-MM-DD) as "fre 4 dec" / "Fri 4 Dec". */
export function dueDayLabel(day: string, locale: "sv" | "en" = "sv"): string {
  const at = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat(tag(locale), { weekday: "short", day: "numeric", month: "short", timeZone: TZ }).format(at).replace(/\./g, "");
}

/** A meeting's day as "26 nov" / "26 Nov". */
export function meetingDayLabel(iso: string, locale: "sv" | "en" = "sv"): string {
  return new Intl.DateTimeFormat(tag(locale), { day: "numeric", month: "short", timeZone: TZ }).format(new Date(iso)).replace(/\./g, "");
}

/** The day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
