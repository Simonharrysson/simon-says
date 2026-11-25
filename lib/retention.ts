import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface RetentionResult {
  usageDailyDeleted: number;
  orgCreationsDeleted: number;
}

/** Deletes usage_daily and org_creations rows older than 24 months (the /integritet promise). */
export async function cleanupRetention(): Promise<RetentionResult> {
  const { data, error } = await supabaseAdmin().rpc("cleanup_retention");
  if (error) throw new Error(`cleanup_retention: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { usage_daily_deleted: number | string; org_creations_deleted: number | string }
    | null
    | undefined;
  return {
    usageDailyDeleted: Number(row?.usage_daily_deleted ?? 0),
    orgCreationsDeleted: Number(row?.org_creations_deleted ?? 0),
  };
}
