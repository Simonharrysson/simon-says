// Concrete tasks (docs/superpowers/specs/2026-11-26-concrete-tasks-design.md): every task has
// Vem (owner), När (due) and Klart när (doneWhen). Pure helpers shared by the tick, the Doc
// renderers, the live page's API and the summaries: which tasks are incomplete, the visible
// placeholders, the Avsluta dialog's answers, and deadlines as dates (overdue).

import type { NoteItemRow } from "@/lib/db/types";
import type { NotesItem } from "@/lib/notes/schema";

/** Control and separator characters → space, spaces collapsed (as the Doc renderer's `clean`). */
// eslint-disable-next-line no-control-regex
const cleanText = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** How a space treats incomplete tasks. "require": placeholders, prompts, Avsluta asks. */
export type TaskMode = "require" | "suggest";

/**
 * The space's task mode. Föreningar follow their setting (default on). When the Privat / Företag
 * space kinds land (orgs.kind), they are "suggest" here: no forcing outside föreningar.
 */
export function taskMode(org: { require_task_fields?: boolean | null; kind?: string | null } | null | undefined): TaskMode {
  if (!org) return "suggest";
  if (org.kind && org.kind !== "forening") return "suggest";
  return org.require_task_fields === false ? "suggest" : "require";
}

/** What the Doc shows for a missing field (Swedish: the Doc's own language). */
export const PLACEHOLDER = { owner: "(vem?)", due: "(deadline?)", doneWhen: "(klart när?)" } as const;
/** The words in front of a known "Klart när" in a Doc line. */
export const DONE_WHEN_LABEL = "klart när:";
/** Added to a carried task's deadline when it has passed. */
export const OVERDUE_MARK = "försenad";

export type TaskField = "owner" | "due" | "doneWhen";
export const TASK_FIELDS: TaskField[] = ["owner", "due", "doneWhen"];

/** The fields a task lacks (empty when complete). */
export function missingFields(item: Pick<NotesItem, "owner" | "due" | "doneWhen">): TaskField[] {
  return TASK_FIELDS.filter((f) => !item[f]?.trim());
}

/** Does this item get placeholders in the Doc: an open task of this meeting (not done, not carried, not the Från förra veckan copy). */
export function asksForFields(item: Pick<NotesItem, "section" | "done" | "carried">): boolean {
  return item.section === "action" && !item.done && !item.carried;
}

/** Items marked for placeholder rendering (`placeholders: true`) when the mode requires them. */
export function markPlaceholders<T extends NotesItem>(items: T[], mode: TaskMode): T[] {
  if (mode !== "require") return items;
  return items.map((i) => (asksForFields(i) && !i.placeholders ? { ...i, placeholders: true } : i));
}

/** A Doc line that still shows one of our placeholders. */
export function hasPlaceholder(text: string): boolean {
  return Object.values(PLACEHOLDER).some((p) => text.includes(p));
}

/** One task the live page and the Avsluta dialog show. */
export interface TaskView {
  id: string;
  text: string;
  owner: string | null;
  due: string | null;
  doneWhen: string | null;
  missing: TaskField[];
  /** A person edited the line in the Doc: we never write to it, so it can only be left as is. */
  locked: boolean;
}

const isPrimaryTask = (r: NoteItemRow) =>
  (r.kind === "task" || (r.kind == null && r.section === "action")) &&
  !r.copy_of &&
  !r.id.endsWith("-t") &&
  r.carried_from_id == null &&
  !r.deleted_by_human;

/**
 * This meeting's own tasks (not the Från förra veckan ones, not the tasks-section copies, not
 * deleted), in Doc order, with what each lacks. A task done (also through its copy) lacks nothing.
 * A human-edited (locked) task lacks what its line still shows as a placeholder: a person who
 * typed the deadline over "(deadline?)" has completed it in the Doc.
 */
export function meetingTasks(rows: NoteItemRow[]): TaskView[] {
  const doneByCopy = new Set(rows.filter((r) => r.done && r.id.endsWith("-t")).map((r) => r.copy_of ?? r.id.slice(0, -2)));
  return rows
    .filter(isPrimaryTask)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id, "sv", { numeric: true }))
    .map((r) => {
      const done = r.done === true || doneByCopy.has(r.id);
      const text = r.text;
      let missing: TaskField[];
      if (done) missing = [];
      else if (r.locked) missing = TASK_FIELDS.filter((f) => text.includes(PLACEHOLDER[f]));
      else missing = missingFields({ owner: r.owner ?? undefined, due: r.due ?? undefined, doneWhen: r.done_when ?? undefined });
      return {
        id: r.id,
        text,
        owner: r.owner ?? null,
        due: r.due ?? null,
        doneWhen: r.done_when ?? null,
        missing,
        locked: r.locked,
      };
    });
}

/** The tasks that still lack Vem, När or Klart när. */
export function incompleteTasks(rows: NoteItemRow[]): TaskView[] {
  return meetingTasks(rows).filter((t) => t.missing.length > 0);
}

// ---------------------------------------------------------------------------------------------
// The Avsluta dialog's answers (meetings.task_answers), applied by the final pass.

export interface TaskAnswer {
  id: string;
  owner?: string;
  due?: string;
  doneWhen?: string;
}

const MAX_ANSWERS = 50;
const MAX_FIELD = 200;
const ID = /^n\d{1,6}$/;

const field = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = cleanText(v);
  return t ? t.slice(0, MAX_FIELD) : undefined;
};

/** Valid answers only: our own task ids (`n<k>`), at least one non-empty field, each ≤ 200 chars. */
export function parseTaskAnswers(value: unknown): TaskAnswer[] {
  if (!Array.isArray(value)) return [];
  const out: TaskAnswer[] = [];
  const seen = new Set<string>();
  for (const v of value.slice(0, MAX_ANSWERS)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || seen.has(o.id)) continue;
    const a: TaskAnswer = { id: o.id };
    const owner = field(o.owner);
    const due = field(o.due);
    const doneWhen = field(o.doneWhen);
    if (owner) a.owner = owner;
    if (due) a.due = due;
    if (doneWhen) a.doneWhen = doneWhen;
    if (!owner && !due && !doneWhen) continue;
    seen.add(o.id);
    out.push(a);
  }
  return out;
}

/**
 * The answers written onto the items (after Claude's final ops, so Claude can't undo them): a
 * field a person typed in the dialog replaces what is there. Items that are not open tasks of
 * this meeting, and ids that aren't in `items` (locked or deleted by a human), are left alone.
 */
export function applyTaskAnswers<T extends NotesItem>(items: T[], answers: TaskAnswer[]): T[] {
  if (!answers.length) return items;
  const byId = new Map(answers.map((a) => [a.id, a]));
  return items.map((item) => {
    const a = byId.get(item.id);
    if (!a || item.section !== "action" || item.carried || item.copyOf) return item;
    return {
      ...item,
      ...(a.owner ? { owner: a.owner } : {}),
      ...(a.due ? { due: a.due } : {}),
      ...(a.doneWhen ? { doneWhen: a.doneWhen } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Deadlines as dates. Conservative: a phrasing we don't know is no date (never overdue).

const MONTHS: [RegExp, number][] = [
  [/^jan(uari|uary)?$/, 1],
  [/^feb(ruari|ruary)?$/, 2],
  [/^mar(s|ch)?$/, 3],
  [/^apr(il)?$/, 4],
  [/^(maj|may)$/, 5],
  [/^jun[ei]?$/, 6],
  [/^jul[iy]?$/, 7],
  [/^aug(usti|ust)?$/, 8],
  [/^sep(t|tember)?$/, 9],
  [/^o[ck]t(ober)?$/, 10],
  [/^nov(ember)?$/, 11],
  [/^dec(ember)?$/, 12],
];
const WEEKDAYS: [RegExp, number][] = [
  [/^(måndag(en)?|monday)$/, 1],
  [/^(tisdag(en)?|tuesday)$/, 2],
  [/^(onsdag(en)?|wednesday)$/, 3],
  [/^(torsdag(en)?|thursday)$/, 4],
  [/^(fredag(en)?|friday)$/, 5],
  [/^(lördag(en)?|saturday)$/, 6],
  [/^(söndag(en)?|sunday)$/, 0],
];

/** The calendar day (YYYY-MM-DD) of an instant in Stockholm. */
export function stockholmDay(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function valid(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ymd(y, m, d) : null;
}
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** A day and month without a year: the one on or after two months before the meeting. */
function nearYear(refDay: string, m: number, d: number): string | null {
  const year = Number(refDay.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const day = valid(y, m, d);
    if (day && day >= addDays(refDay, -60)) return day;
  }
  return null;
}

/**
 * `due` as a calendar day (YYYY-MM-DD), relative to the meeting it was said in, or null:
 * "2026-12-03", "3 dec", "3 december 2026", "3/12", a weekday ("fredag": the next one after the
 * meeting day), "imorgon"/"tomorrow". Everything else ("till nästa möte", "snart") is null.
 */
export function resolveDue(due: string | null | undefined, ref: Date | string): string | null {
  const t = due?.normalize("NFC").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const refDay = stockholmDay(ref);
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2}) ([a-zåäö]+)(?: (\d{4}))?\b/.exec(t);
  if (m) {
    const month = MONTHS.find(([re]) => re.test(m![2]))?.[1];
    if (month) return m[3] ? valid(Number(m[3]), month, Number(m[1])) : nearYear(refDay, month, Number(m[1]));
  }
  m = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:$|\s)/.exec(t);
  if (m) return nearYear(refDay, Number(m[2]), Number(m[1]));
  if (/\b(imorgon|i morgon|tomorrow)\b/.test(t)) return addDays(refDay, 1);
  for (const word of t.split(" ")) {
    const wd = WEEKDAYS.find(([re]) => re.test(word))?.[1];
    if (wd === undefined) continue;
    const [y, mo, d] = refDay.split("-").map(Number);
    const today = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const ahead = ((wd - today + 7) % 7) || 7;
    return addDays(refDay, ahead);
  }
  return null;
}

/** A deadline day before `today` (both YYYY-MM-DD). */
export function isOverdue(dueDate: string | null | undefined, today: string): boolean {
  return Boolean(dueDate) && dueDate! < today;
}

/**
 * Rows with `due_date` resolved against the meeting's start. Carried rows keep their source's
 * (their `due` was said in another meeting); a row without a due has none.
 */
export function withDueDates(rows: NoteItemRow[], meetingStartedAt: string): NoteItemRow[] {
  return rows.map((r) => {
    if (r.carried_from_id != null) return r;
    const due_date = r.section === "action" ? resolveDue(r.due, meetingStartedAt) : null;
    return (r.due_date ?? null) === due_date ? r : { ...r, due_date };
  });
}

// ---------------------------------------------------------------------------------------------
// The Avsluta dialog (components/live/EndTasksDialog.tsx): each incomplete task completed or dismissed.

/** How the Avsluta dialog handled one incomplete task. */
export type EndHandled = { kind: "completed"; values: Partial<Record<TaskField, string>> } | { kind: "dismissed" };

/** Every task handled: completed (all its missing fields typed; never a locked one) or dismissed. */
export function endReady(tasks: TaskView[], handled: Record<string, EndHandled | undefined>): boolean {
  return tasks.every((t) => {
    const h = handled[t.id];
    if (!h) return false;
    if (h.kind === "dismissed") return true;
    return !t.locked && t.missing.every((f) => h.values[f]?.trim());
  });
}

/** The answers POST /end carries: completed tasks only, the missing fields as typed. */
export function endAnswers(tasks: TaskView[], handled: Record<string, EndHandled | undefined>): TaskAnswer[] {
  return tasks.flatMap((t) => {
    const h = handled[t.id];
    if (h?.kind !== "completed") return [];
    const a: TaskAnswer = { id: t.id };
    for (const f of t.missing) {
      const v = h.values[f]?.trim();
      if (v) a[f] = v;
    }
    return [a];
  });
}
