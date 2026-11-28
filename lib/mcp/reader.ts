import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentStatus, AgentStatusRow } from "@/lib/agent/tasks";
import type { HandoffRow, HomeMeeting, HomeNoteRow, HomePerson, PrivatTaskRow } from "@/lib/home/tasks";
import { readMoments, type MomentLine } from "@/lib/meetings/moments";

// What the MCP tools read, for one user: the mcp_* functions of 0060, called with the service role
// for an explicit p_user. Each one asks the same predicate as the table's RLS policy, acting as
// that user (can_see_meeting, is_org_member, is_context_member, can_approve_handoff), so nothing
// here restates a visibility rule. No other read path exists for the tools.

export interface McpOrg {
  id: string;
  name: string;
  kind: "forening" | "foretag" | "privat";
  role: "admin" | "member";
}

export type McpMeeting = HomeMeeting & { group_id?: string | null; private?: boolean };

export interface McpReader {
  userId: string;
  orgs(): Promise<McpOrg[]>;
  meetings(q: { org?: string | null; ids?: string[] | null; from?: string | null; to?: string | null; done: boolean; limit: number }): Promise<McpMeeting[]>;
  noteItems(meetingIds: string[], like?: string | null): Promise<HomeNoteRow[]>;
  people(orgIds: string[]): Promise<HomePerson[]>;
  contexts(orgIds: string[]): Promise<{ id: string; org_id: string; name: string }[]>;
  privateSummaries(meetingIds: string[], like?: string | null): Promise<{ meeting_id: string; summary: string; decisions: string[]; people: string[] }[]>;
  contextTasks(contextIds: string[]): Promise<PrivatTaskRow[]>;
  handoffs(orgIds: string[]): Promise<HandoffRow[]>;
  setHandoffDone(id: string, done: boolean): Promise<boolean>;
  setPrivatTaskDone(id: string, done: boolean): Promise<boolean>;
  /** Claude's progress on agent tasks (0065, is_meeting_member). */
  agentStatuses(meetingIds: string[]): Promise<AgentStatusRow[]>;
  /** mcp_set_agent_task: the meeting seen, finished, and the user its assigner or an admin. */
  setAgentTask(meetingId: string, itemId: string, status: AgentStatus, note: string | null): Promise<boolean>;
  /** The org's "Vad Claude ska veta" (0065, is_org_member), or null when there is none. */
  orgMemory(orgId: string): Promise<McpOrgMemory | null>;
  /**
   * 0068: the source lines of some items of one meeting, only when the user may read its transcript
   * (transcript_moment_lines: the same rule as the meeting page's ▶ link).
   */
  moments?(meetingId: string, itemIds: string[]): Promise<Map<string, MomentLine[]>>;
}

export interface McpOrgMemory {
  org_id: string;
  lines: unknown;
  generated_at: string | null;
  sources_from: string | null;
  sources_count: number | null;
  updated_at: string | null;
}

export function dbReader(admin: SupabaseClient, userId: string): McpReader {
  const rpc = async <T,>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, { p_user: userId, ...args });
    if (error) throw new Error(`mcp reader: ${fn}: ${error.message}`);
    return data as T;
  };
  const chunks = async <T,>(ids: string[], read: (part: string[]) => Promise<T[]>): Promise<T[]> => {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 100) out.push(...(await read(ids.slice(i, i + 100))));
    return out;
  };
  return {
    userId,
    orgs: async () =>
      ((await rpc<McpOrg[]>("mcp_orgs", {})) ?? []).map((o) => ({ ...o, kind: o.kind === "privat" || o.kind === "foretag" ? o.kind : "forening" })),
    meetings: async (q) =>
      (await rpc<McpMeeting[]>("mcp_meetings", {
        p_org: q.org ?? null,
        p_ids: q.ids ?? null,
        p_from: q.from ?? null,
        p_to: q.to ?? null,
        p_done: q.done,
        p_limit: q.limit,
      })) ?? [],
    noteItems: (ids, like) => (ids.length ? chunks(ids, async (part) => (await rpc<HomeNoteRow[]>("mcp_note_items", { p_meeting_ids: part, p_like: like ?? null })) ?? []) : Promise.resolve([])),
    people: async (orgIds) => (orgIds.length ? ((await rpc<HomePerson[]>("mcp_people", { p_org_ids: orgIds })) ?? []) : []),
    contexts: async (orgIds) => (orgIds.length ? ((await rpc<{ id: string; org_id: string; name: string }[]>("mcp_contexts", { p_org_ids: orgIds })) ?? []) : []),
    privateSummaries: (ids, like) =>
      ids.length
        ? chunks(ids, async (part) => (await rpc<{ meeting_id: string; summary: string; decisions: string[]; people: string[] }[]>("mcp_private_summaries", { p_meeting_ids: part, p_like: like ?? null })) ?? [])
        : Promise.resolve([]),
    contextTasks: (ids) => (ids.length ? chunks(ids, async (part) => (await rpc<PrivatTaskRow[]>("mcp_context_tasks", { p_context_ids: part })) ?? []) : Promise.resolve([])),
    handoffs: async (orgIds) => (orgIds.length ? ((await rpc<HandoffRow[]>("mcp_handoffs", { p_org_ids: orgIds })) ?? []) : []),
    setHandoffDone: async (id, done) => (await rpc<boolean>("mcp_set_handoff_done", { p_id: id, p_done: done })) === true,
    setPrivatTaskDone: async (id, done) => (await rpc<boolean>("mcp_set_privat_task_done", { p_id: id, p_done: done })) === true,
    agentStatuses: (ids) =>
      ids.length ? chunks(ids, async (part) => (await rpc<AgentStatusRow[]>("mcp_agent_task_status", { p_meeting_ids: part })) ?? []) : Promise.resolve([]),
    setAgentTask: async (meetingId, itemId, status, note) =>
      (await rpc<boolean>("mcp_set_agent_task", { p_meeting: meetingId, p_item: itemId, p_status: status, p_note: note })) === true,
    orgMemory: async (orgId) => ((await rpc<McpOrgMemory[]>("mcp_org_memory", { p_org: orgId })) ?? [])[0] ?? null,
    moments: (meetingId, itemIds) => readMoments(admin, userId, meetingId, itemIds, 0),
  };
}
