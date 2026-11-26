import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MeetingStatus, SummaryState } from "@/lib/db/types";
import { sortContexts, type ContextRow } from "./contexts";
import type { SinceLastItem } from "./since-last";
import type { SummaryForLog } from "./log";

// What the Privat pages read, as the signed-in user (RLS: only their own space is visible).

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`privat ${what}: ${res.error.message}`);
  return res.data;
}

export interface PrivatMeetingRow {
  id: string;
  context_id: string | null;
  status: MeetingStatus;
  started_at: string;
  ended_at: string | null;
  doc_id: string | null;
  summary_state: SummaryState | null;
}

export interface SummaryRow extends SummaryForLog {
  summary: string;
  questions: string[];
  since_last: SinceLastItem[];
  previous_meeting_id: string | null;
}

export interface TaskRow {
  id: string;
  context_id: string;
  meeting_id: string;
  text: string;
  owner: string | null;
  done: boolean;
  done_at: string | null;
  created_at: string;
}

const MEETING_COLS = "id, context_id, status, started_at, ended_at, doc_id, summary_state";

export interface ContextSummary extends ContextRow {
  openTasks: number;
  recordings: number;
  lastAt: string | null;
}

/** The space's contexts with counts, and its running recording (if any). */
export async function loadSpace(db: SupabaseClient, spaceId: string): Promise<{ contexts: ContextSummary[]; running: PrivatMeetingRow | null }> {
  const [contexts, meetings, tasks] = await Promise.all([
    db.from("contexts").select("id, name, created_at, last_used_at").eq("org_id", spaceId),
    db.from("meetings").select(MEETING_COLS).eq("org_id", spaceId).order("started_at", { ascending: false }).limit(500),
    db.from("context_tasks").select("context_id").eq("done", false).limit(2000),
  ]);
  const ms = must("meetings", meetings) as PrivatMeetingRow[];
  const open = must("tasks", tasks) as { context_id: string }[];
  const rows = sortContexts(must("contexts", contexts) as ContextRow[]).map((c) => {
    const mine = ms.filter((m) => m.context_id === c.id);
    return { ...c, openTasks: open.filter((t) => t.context_id === c.id).length, recordings: mine.length, lastAt: mine[0]?.started_at ?? null };
  });
  return { contexts: rows, running: ms.find((m) => m.status === "live" || m.status === "ending") ?? null };
}

export interface ContextPageData {
  context: ContextRow & { org_id: string };
  meetings: (PrivatMeetingRow & { summary: string | null })[];
  open: TaskRow[];
  done: TaskRow[];
  summaries: SummaryRow[];
}

export async function loadContextPage(db: SupabaseClient, contextId: string): Promise<ContextPageData | null> {
  const context = must("context", await db.from("contexts").select("id, org_id, name, created_at, last_used_at").eq("id", contextId).maybeSingle()) as
    | (ContextRow & { org_id: string })
    | null;
  if (!context) return null;
  const [meetings, tasks, summaries] = await Promise.all([
    db.from("meetings").select(MEETING_COLS).eq("context_id", contextId).order("started_at", { ascending: false }).limit(200),
    db.from("context_tasks").select("id, context_id, meeting_id, text, owner, done, done_at, created_at").eq("context_id", contextId).order("created_at").limit(500),
    db.from("private_summaries").select("meeting_id, created_at, summary, decisions, facts, questions, people, topics, since_last, previous_meeting_id").eq("context_id", contextId),
  ]);
  const ms = must("meetings", meetings) as PrivatMeetingRow[];
  const startedAt = new Map(ms.map((m) => [m.id, m.started_at]));
  const sums = (must("summaries", summaries) as Omit<SummaryRow, "started_at">[]).map((s) => ({ ...s, started_at: startedAt.get(s.meeting_id) ?? s.created_at }));
  const bySummary = new Map(sums.map((s) => [s.meeting_id, s.summary]));
  const ts = must("tasks", tasks) as TaskRow[];
  return {
    context,
    meetings: ms.map((m) => ({ ...m, summary: bySummary.get(m.id) ?? null })),
    open: ts.filter((t) => !t.done),
    // The last few ticked ones, newest first, so a mistaken tick can be undone.
    done: ts
      .filter((t) => t.done)
      .sort((a, b) => Date.parse(b.done_at ?? b.created_at) - Date.parse(a.done_at ?? a.created_at))
      .slice(0, 10),
    summaries: sums,
  };
}

export interface MeetingPageData {
  meeting: PrivatMeetingRow & { org_id: string };
  context: { id: string; name: string } | null;
  summary: SummaryRow | null;
  tasks: TaskRow[];
}

export async function loadMeetingPage(db: SupabaseClient, meetingId: string): Promise<MeetingPageData | null> {
  const meeting = must("meeting", await db.from("meetings").select(`${MEETING_COLS}, org_id`).eq("id", meetingId).maybeSingle()) as
    | (PrivatMeetingRow & { org_id: string })
    | null;
  if (!meeting || !meeting.context_id) return null;
  const [context, summary, tasks] = await Promise.all([
    db.from("contexts").select("id, name").eq("id", meeting.context_id).maybeSingle(),
    db
      .from("private_summaries")
      .select("meeting_id, created_at, summary, decisions, facts, questions, people, topics, since_last, previous_meeting_id")
      .eq("meeting_id", meetingId)
      .maybeSingle(),
    db.from("context_tasks").select("id, context_id, meeting_id, text, owner, done, done_at, created_at").eq("meeting_id", meetingId).order("position"),
  ]);
  const s = must("summary", summary) as Omit<SummaryRow, "started_at"> | null;
  return {
    meeting,
    context: must("context", context) as { id: string; name: string } | null,
    summary: s ? { ...s, started_at: meeting.started_at } : null,
    tasks: must("tasks", tasks) as TaskRow[],
  };
}
