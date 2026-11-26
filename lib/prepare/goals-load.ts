import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listGoals } from "@/lib/dashboard/load";
import type { DashInput, DashItem, DashMeeting } from "@/lib/dashboard/overview";
import type { HistoryItem, HistoryMeeting } from "@/lib/history/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { goalMeetings, MAX_GOAL_SUGGESTIONS, suggestGoals, type GoalSuggestion } from "./goals";

// "Mål att ta upp" (todo #12), server side: the suggestions for a förening (read with the caller's
// client, RLS, over a bounded window), and the titles of goals ticked on the start screen (re-read
// here, never the browser's text). Neither ever fails a draft or a start.

/** The window the suggestions read: the last six months of meetings and imported protocols. */
export const GOAL_WINDOW_DAYS = 183;
const MAX_ROWS = 2000;

/**
 * The förening's meetings and imported protocols in the window, only the columns the rule reads
 * (bounded: the start screen loads this on every open).
 */
async function windowInput(db: SupabaseClient, orgId: string, from: string): Promise<{ own: Pick<DashInput, "meetings" | "items">; imported: HistoryMeeting[] }> {
  const [meetingsRes, protocolsRes] = await Promise.all([
    db
      .from("meetings")
      .select("id, org_id, started_at, status, is_test, agenda_roles, agenda_labels")
      .eq("org_id", orgId)
      .eq("is_test", false)
      .in("status", ["done", "abandoned"])
      .gte("started_at", from)
      .order("started_at", { ascending: false })
      .limit(60),
    db.from("history_protocols").select("id, meeting_date").eq("org_id", orgId).gte("meeting_date", from.slice(0, 10)).order("meeting_date").limit(60),
  ]);
  if (meetingsRes.error) throw new Error(`meetings: ${meetingsRes.error.message}`);
  const meetings = (meetingsRes.data ?? []) as DashMeeting[];
  let items: DashItem[] = [];
  if (meetings.length) {
    const res = await db
      .from("note_items")
      .select("meeting_id, id, section, kind, text, anchor, deleted_by_human, copy_of")
      .in(
        "meeting_id",
        meetings.map((m) => m.id),
      )
      .or("kind.in.(decision,task),and(kind.is.null,section.in.(decision,action))")
      .limit(MAX_ROWS);
    if (res.error) throw new Error(`items: ${res.error.message}`);
    items = (res.data ?? []) as DashItem[];
  }
  // A failed history read only leaves the old protocols out.
  let imported: HistoryMeeting[] = [];
  const protocols = protocolsRes.error ? [] : ((protocolsRes.data ?? []) as { id: string; meeting_date: string }[]);
  if (protocols.length) {
    const res = await db
      .from("history_items")
      .select("protocol_id, kind, text, topic")
      .eq("org_id", orgId)
      .in(
        "protocol_id",
        protocols.map((p) => p.id),
      )
      .limit(MAX_ROWS);
    if (!res.error) {
      const rows = (res.data ?? []) as { protocol_id: string; kind: HistoryItem["kind"]; text: string; topic: string | null }[];
      imported = protocols.map((p) => ({
        date: p.meeting_date,
        source: "import" as const,
        items: rows.filter((r) => r.protocol_id === p.id).map((r) => ({ kind: r.kind, text: r.text, topic: r.topic, owner: null, done: null })),
      }));
    }
  }
  return { own: { meetings, items }, imported };
}

export async function goalSuggestionsFor(userDb: SupabaseClient, orgId: string, now = new Date()): Promise<GoalSuggestion[]> {
  try {
    const goals = await listGoals(userDb, orgId);
    if (!goals.length) return [];
    const from = new Date(now.getTime() - GOAL_WINDOW_DAYS * 86_400_000).toISOString();
    const { own, imported } = await windowInput(userDb, orgId, from);
    return suggestGoals(goals, goalMeetings(orgId, own, imported), now, { from });
  } catch (err) {
    console.error(`goals: suggestions unavailable: ${(err as Error).message}`);
    return [];
  }
}

/** The förening's current goals among `ids` (at most two), in their own order. */
export async function goalTitles(orgId: string, ids: string[]): Promise<string[]> {
  const want = [...new Set(ids)].slice(0, MAX_GOAL_SUGGESTIONS);
  if (!want.length) return [];
  const { data, error } = await supabaseAdmin().from("org_goals").select("id, title").eq("org_id", orgId).in("id", want).order("position");
  if (error) {
    console.error(`goals: titles unavailable: ${error.message}`);
    return [];
  }
  return ((data ?? []) as { title: string }[]).map((g) => g.title);
}
