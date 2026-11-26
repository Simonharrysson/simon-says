// Old protocols → the förening's goals (todo #7). Shared types, pure.
//
// One imported protocol is reduced to short structured items (never the Doc text): agenda topics,
// decisions, tasks (owner as a role, done or not) and "reports" (one-line status notes: how far
// something has come, that it was reached, paused or given up). Reports carry the signal that a
// goal was achieved or dropped when no formal decision says so.

export type HistoryKind = "topic" | "decision" | "task" | "report";

export interface HistoryItem {
  kind: HistoryKind;
  text: string;
  /** Agenda item the line sits under (decision, task, report), when known. */
  topic: string | null;
  /** Task owner as a role ("Kassör"), never a name. */
  owner: string | null;
  /** Task done? null when the protocol does not say. */
  done: boolean | null;
}

/** One meeting in the chronological history the digest reads. */
export interface HistoryMeeting {
  /** YYYY-MM-DD. */
  date: string;
  source: "import" | "simonsays";
  items: HistoryItem[];
}

export const GOAL_STATUSES = ["current", "achieved", "dropped", "stale"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface DigestEvidence {
  date: string;
  text: string;
}

/** One goal as the digest proposes it (after the code-side checks in digest-input.ts). */
export interface DigestGoal {
  title: string;
  status: GoalStatus;
  why: string;
  /** Names the goal had earlier (renamed goals), newest last. */
  earlierNames: string[];
  firstMentioned: string;
  lastMentioned: string;
  evidence: DigestEvidence[];
}
