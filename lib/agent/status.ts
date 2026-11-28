import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentStatusRow } from "./tasks";

// Claude's progress on the tasks a meeting gave it (agent_task_status, 0065), read with the user's
// own client: RLS (is_meeting_member) shows only rows of meetings the user can see.

/** Missing table (code deployed before 0065): no progress yet, never an error page. */
const missing = (e: { code?: string; message: string }) => e.code === "42P01" || e.code === "PGRST205" || /agent_task_status/.test(e.message) && /does not exist|schema cache/.test(e.message);

export async function readAgentStatuses(db: SupabaseClient, meetingIds: string[]): Promise<AgentStatusRow[]> {
  const out: AgentStatusRow[] = [];
  for (let i = 0; i < meetingIds.length; i += 100) {
    const { data, error } = await db
      .from("agent_task_status")
      .select("meeting_id, item_id, status, note, updated_at")
      .in("meeting_id", meetingIds.slice(i, i + 100));
    if (error) {
      if (missing(error)) return [];
      throw new Error(`agent_task_status: ${error.message}`);
    }
    out.push(...((data ?? []) as AgentStatusRow[]));
  }
  return out;
}
