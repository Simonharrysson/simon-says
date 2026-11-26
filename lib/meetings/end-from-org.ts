import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memberRole } from "@/lib/db/orgs";
import { canEndFromOrgPage } from "@/lib/meetings/access";
import { claimEnd } from "@/lib/meetings/tick";

export type OrgEndResult = "ending" | "noop" | "forbidden" | "not_found";

/**
 * "Avsluta mötet" on the org page (admins and the starter): live → ending, the same end as the
 * live page's Avsluta. The caller runs finishMeeting after the response; the cron retries it.
 */
export async function endFromOrgPage(db: SupabaseClient, userId: string, meetingId: string): Promise<OrgEndResult> {
  // As the user: RLS hides meetings of other orgs.
  const { data: m, error } = await db.from("meetings").select("id, org_id, started_by").eq("id", meetingId).maybeSingle();
  if (error) throw new Error(`end from org: ${error.message}`);
  if (!m) return "not_found";
  const role = await memberRole(db, m.org_id as string, userId);
  if (!canEndFromOrgPage(role, m.started_by === userId)) return "forbidden";
  const claim = await claimEnd(m.id as string);
  return claim === "claimed" ? "ending" : claim;
}
