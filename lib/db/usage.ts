import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Seconds the org has used this calendar month (UTC): closed sessions' seconds from
 * usage_daily plus the elapsed time of open sessions. The single source for caps.
 */
export async function orgMonthSeconds(orgId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("org_month_seconds", { p_org_id: orgId });
  if (error) throw new Error(`orgMonthSeconds: ${error.message}`);
  return Number(data ?? 0);
}

/** Today's (UTC) recorded spend in USD across all orgs. */
export async function dayUsd(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin().from("usage_daily").select("usd").eq("day", today);
  if (error) throw new Error(`dayUsd: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.usd), 0);
}
