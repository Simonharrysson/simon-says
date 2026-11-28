import type { NoteItemRow } from "@/lib/db/types";
import type { RolePerson } from "@/lib/people/roles";

// "Claude, gör det här" (docs/superpowers/specs/2026-11-28-claude-tasks-memory-design.md, A): a
// meeting task given to Claude, the AI assistant. Deterministic and gentle: only when the owner
// text says so in so many words, and never when that text names a real person or role of the org
// (a member called Claude keeps the task). Pure.

export const AGENT_STATUSES = ["in_progress", "done", "blocked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
/** The status shown: a row in agent_task_status, else open. */
export type AgentState = AgentStatus | "open";

export interface AgentStatusRow {
  meeting_id: string;
  item_id: string;
  status: AgentStatus;
  note: string | null;
  updated_at: string;
}

/** What a task row says about Claude (MyTask.agent / MeetingTask.agent). */
export interface AgentInfo {
  status: AgentState;
  note: string | null;
}

const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:!]+$/, "")
    .trim()
    .toLocaleLowerCase("sv");

/** The owner texts that mean the assistant, normalised. */
const AGENT_OWNERS = new Set(["claude", "ai", "ai:n", "ain", "simon says", "claude (ai)", "claude ai"]);

/** The owner text says Claude / AI / Simon Says, and nothing else. */
export function isAgentOwner(owner: string | null | undefined): boolean {
  return Boolean(owner) && AGENT_OWNERS.has(norm(owner!));
}

/** Does `text` name anyone in the org: a full name, a first name or a role (any match, not only a unique one). */
function namesSomeone(text: string, people: RolePerson[]): boolean {
  const t = norm(text);
  return people.some((p) => {
    const name = norm(p.name);
    if (name === t || name.split(" ")[0] === t) return true;
    return p.role ? norm(p.role) === t : false;
  });
}

/**
 * A task row Claude was given: owner text is the assistant, no owner link, the row is ours (not a
 * line a human edited, whose owner field is no longer what the Doc says) and nobody in the org is
 * called that. The caller checks it is a task at all (isTask) and visible.
 */
export function isAgentTask(row: Pick<NoteItemRow, "owner" | "owner_person_id" | "locked">, orgPeople: RolePerson[]): boolean {
  if (row.locked || row.owner_person_id) return false;
  if (!isAgentOwner(row.owner)) return false;
  return !namesSomeone(row.owner!, orgPeople);
}

/** The state of one agent task: done on the note row wins, then the status row, else open. */
export function agentState(done: boolean, status: Pick<AgentStatusRow, "status" | "note"> | undefined): AgentInfo {
  if (done) return { status: "done", note: status?.note ?? null };
  if (!status) return { status: "open", note: null };
  // A status row saying done while the row isn't (the Doc write path failed half-way): still open work.
  return { status: status.status === "done" ? "in_progress" : status.status, note: status.note };
}

/** Who may move an agent task: its assigner (the meeting's runner) or an admin of the org. */
export function canUpdateAgentTask(input: { userId: string; startedBy: string | null | undefined; isAdmin: boolean }): boolean {
  return input.isAdmin || (Boolean(input.startedBy) && input.startedBy === input.userId);
}

export const statusKey = (meetingId: string, itemId: string) => `${meetingId}\u0000${itemId}`;

/** Status rows by (meeting, item). */
export function statusMap(rows: AgentStatusRow[]): Map<string, AgentStatusRow> {
  return new Map(rows.map((r) => [statusKey(r.meeting_id, r.item_id), r]));
}
