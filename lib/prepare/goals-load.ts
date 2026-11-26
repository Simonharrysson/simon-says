import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listGoals, loadOverviewInput } from "@/lib/dashboard/load";
import type { DashInput } from "@/lib/dashboard/overview";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { goalMeetings, MAX_GOAL_SUGGESTIONS, suggestGoals, type GoalSuggestion } from "./goals";

// "Mål att ta upp" (todo #12), server side: the suggestions for a förening (read with the caller's
// client, RLS), and the titles of goals ticked on the start screen (re-read here, never the
// browser's text). Neither ever fails a draft or a start.

export async function goalSuggestionsFor(userDb: SupabaseClient, orgId: string, now = new Date(), overview?: DashInput): Promise<GoalSuggestion[]> {
  try {
    const input = overview ?? (await loadOverviewInput(userDb, orgId));
    return suggestGoals(await listGoals(userDb, orgId), goalMeetings(orgId, input), now);
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
