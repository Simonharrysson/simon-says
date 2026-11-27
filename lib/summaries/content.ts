import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { isCopy, isDecision, isTask } from "@/lib/meetings/summary";
import { PLACEHOLDER, TASK_FIELDS, isOverdue, missingFields, stripPlaceholders, type TaskField } from "@/lib/notes/tasks";
import { resolveOwner } from "@/lib/people/roles";

// What a summary e-mail says, built from the meeting's stored note rows (no Claude call). Pure.
// - Beslut: the meeting's decisions; Uppgifter: its open tasks (done ones are left out: a
//   summary is about what is left to do), the recipient's own first (by owner_person_id, or the
//   owner text naming them by name, first name or role); Övrigt: up to 3 other notes.
// - Never anything under a Må-runda item (the private part of the meeting, like the dashboard),
//   no "info.*" cells (time, place), no copies, nothing a human deleted.
// - Each list is capped; the rest is "N till i protokollet".

export const MAX_DECISIONS = 8;
export const MAX_TASKS = 10;
export const MAX_OTHER = 3;
/** One line in an e-mail: longer note texts are cut with "…". */
export const MAX_LINE = 280;

export type SummaryItem = Pick<NoteItemRow, "id" | "section" | "text" | "owner" | "due" | "position"> &
  Partial<
    Pick<
      NoteItemRow,
      "kind" | "done" | "deleted_by_human" | "copy_of" | "anchor" | "owner_person_id" | "meeting_id" | "carried_from_meeting" | "carried_from_id" | "done_when" | "due_date" | "locked"
    >
  >;

export interface SummaryTask {
  text: string;
  owner: string | null;
  due: string | null;
  /** "Klart när" (0049); null = not said. */
  doneWhen?: string | null;
  /** Its deadline day is before the day the e-mail is made. */
  overdue?: boolean;
  /** What it still lacks, when the förening requires Vem, När and Klart när (else empty). */
  missing?: TaskField[];
  /** The recipient's own task. */
  mine: boolean;
}

export interface SummaryContent {
  decisions: string[];
  tasks: SummaryTask[];
  other: string[];
  /** Items beyond the caps, per list. */
  more: { decisions: number; tasks: number; other: number };
}

const clean = (text: string) => {
  const t = text.normalize("NFC").replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1).trimEnd()}…` : t;
};

/** Rows the e-mail may show at all. */
function visible(r: SummaryItem, roles: Record<string, ItemRole>): boolean {
  if (r.deleted_by_human) return false;
  if (r.anchor && (roles[r.anchor] === "checkin" || r.anchor.startsWith("info."))) return false;
  return clean(r.text).length > 0;
}

/** Övrigt: notes under a topic or the Övrigt item (or none), not under opening/procedural or follow-up items. */
const OTHER_SKIP = new Set<ItemRole>(["procedural", "followup", "checkin"]);

const asChain = (r: SummaryItem) => ({
  meeting_id: r.meeting_id ?? "",
  id: r.id,
  section: r.section,
  kind: r.kind ?? null,
  done: r.done ?? false,
  deleted_by_human: r.deleted_by_human ?? false,
  copy_of: r.copy_of ?? null,
  carried_from_meeting: r.carried_from_meeting ?? null,
  carried_from_id: r.carried_from_id ?? null,
});

/** The content for one meeting; `forPerson` marks that person's tasks and puts them first. */
export function summaryContent(
  items: SummaryItem[],
  opts: {
    agendaRoles?: Record<string, ItemRole> | null;
    people?: { id: string; name: string; role?: string | null }[];
    forPerson?: { id: string } | null;
    /** The day (YYYY-MM-DD) the e-mail is made: tasks due before it are overdue. */
    today?: string;
    /** The förening requires Vem, När and Klart när: list what each task lacks. */
    requireFields?: boolean;
  } = {},
): SummaryContent {
  const roles = opts.agendaRoles ?? {};
  const rows = items.filter((r) => visible(r, roles)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  // A task is done on its row or on its tasks-section copy ("✓ klart").
  const doneCopies = new Set(rows.filter((r) => isCopy(r) && r.done).map((r) => r.copy_of ?? r.id.slice(0, -2)));
  const decisions = rows.filter((r) => isDecision(asChain(r))).map((r) => clean(r.text));
  const me = opts.forPerson?.id ?? null;
  const people = opts.people ?? [];
  const mine = (r: SummaryItem) =>
    me !== null && (r.owner_person_id === me || (r.owner ? resolveOwner(r.owner, people)?.id === me : false));
  const allTasks = rows
    .filter((r) => isTask(asChain(r)) && !r.done && !doneCopies.has(r.id))
    .map((r) => ({
      // A person's line may still carry our placeholders: never in the e-mail ("saknar …" says it).
      text: clean(r.locked ? stripPlaceholders(r.text) : r.text),
      owner: r.owner?.trim() || null,
      due: r.due?.trim() || null,
      doneWhen: r.done_when?.trim() || null,
      overdue: opts.today ? isOverdue(r.due_date, opts.today) : false,
      missing: opts.requireFields ? lacks(r) : [],
      mine: mine(r),
    }));
  const tasks = [...allTasks.filter((t) => t.mine), ...allTasks.filter((t) => !t.mine)];
  const other = rows
    .filter((r) => (r.kind === "note" || (r.kind == null && r.section === "note")) && !isCopy(r) && !(r.anchor && OTHER_SKIP.has(roles[r.anchor])))
    .map((r) => clean(r.text));
  return {
    decisions: decisions.slice(0, MAX_DECISIONS),
    tasks: tasks.slice(0, MAX_TASKS),
    other: other.slice(0, MAX_OTHER),
    more: {
      decisions: Math.max(0, decisions.length - MAX_DECISIONS),
      tasks: Math.max(0, tasks.length - MAX_TASKS),
      other: Math.max(0, other.length - MAX_OTHER),
    },
  };
}

/** What a task lacks; a human-edited line lacks what it still shows as a placeholder. */
function lacks(r: SummaryItem): TaskField[] {
  // Från förra veckan: nothing here can complete them (they are last meeting's), so never nag.
  if (r.carried_from_id != null) return [];
  if (r.locked) return TASK_FIELDS.filter((f) => r.text.includes(PLACEHOLDER[f]));
  return missingFields({ owner: r.owner ?? undefined, due: r.due ?? undefined, doneWhen: r.done_when ?? undefined });
}

/** Nothing worth mailing: no decision, no open task, no other note. */
export function isEmptySummary(c: SummaryContent): boolean {
  return c.decisions.length === 0 && c.tasks.length === 0 && c.other.length === 0;
}

/**
 * Did the meeting itself note anything? Rows carried in from the last meeting ("Från förra veckan")
 * are there from the start, so they alone don't make a summary.
 */
export function hasOwnNotes(items: SummaryItem[], agendaRoles?: Record<string, ItemRole> | null): boolean {
  return !isEmptySummary(summaryContent(items.filter((r) => !r.carried_from_id), { agendaRoles }));
}
