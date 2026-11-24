import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatusData } from "@/components/views/StatusView";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Same threshold as the alarm email: 3 failed ticks in a row. */
const DEGRADED_FAILED_TICKS = 3;

/**
 * The public status numbers. Takes a service-role client and returns ONLY aggregates and,
 * for orgs with show_on_status, their name. Nothing else about a meeting or org leaves here.
 * "This week" is the last 7 days; minutes come from usage_daily (server-counted seconds).
 */
export async function loadStatus(db: SupabaseClient, killSwitch: boolean, now = new Date()): Promise<StatusData> {
  const since = new Date(now.getTime() - WEEK_MS);
  const sinceDay = since.toISOString().slice(0, 10);

  const [live, usage, started] = await Promise.all([
    db.from("meetings").select("id, org_id, started_at, failed_ticks").in("status", ["live", "ending"]),
    db.from("usage_daily").select("seconds").gte("day", sinceDay),
    db.from("meetings").select("id", { count: "exact", head: true }).gte("started_at", since.toISOString()),
  ]);
  for (const r of [live, usage, started]) if (r.error) throw new Error(`status query failed: ${r.error.message}`);

  const meetings = live.data ?? [];
  const orgIds = [...new Set(meetings.map((m) => m.org_id as string))];
  const names = new Map<string, string>();
  if (orgIds.length > 0) {
    const orgs = await db.from("orgs").select("id, name, show_on_status").in("id", orgIds).eq("show_on_status", true);
    if (orgs.error) throw new Error(`status query failed: ${orgs.error.message}`);
    // Re-check the flag here too: the name must never leak if the filter above is ever lost.
    for (const o of orgs.data ?? []) if (o.show_on_status === true) names.set(o.id as string, o.name as string);
  }

  const seconds = (usage.data ?? []).reduce((sum, r) => sum + Number(r.seconds ?? 0), 0);
  const health: StatusData["health"] = killSwitch
    ? "paused"
    : meetings.some((m) => Number(m.failed_ticks ?? 0) >= DEGRADED_FAILED_TICKS)
      ? "degraded"
      : "ok";

  return {
    health,
    liveMeetings: meetings.map((m) => ({
      id: m.id as string,
      startedAt: m.started_at as string,
      elapsedMs: Math.max(0, now.getTime() - new Date(m.started_at as string).getTime()),
      orgName: names.get(m.org_id as string) ?? null,
    })),
    minutesThisWeek: Math.round(seconds / 60),
    meetingsThisWeek: started.count ?? 0,
    updatedAt: now.toISOString(),
  };
}
