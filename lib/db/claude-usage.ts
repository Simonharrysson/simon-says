import "server-only";
import { spendAlarmInBackground } from "@/lib/alarm";
import type { NotesUsage } from "@/lib/notes/engine";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Add one Claude call's tokens and dollars to the org's usage_daily row (atomic), then check the spend alarm. */
export async function recordClaudeUsage(orgId: string, u: NotesUsage): Promise<void> {
  if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.usd) return;
  const { error } = await supabaseAdmin().rpc("record_claude_usage", {
    p_org_id: orgId,
    p_input: u.input,
    p_output: u.output,
    p_cache_read: u.cacheRead,
    p_cache_write: u.cacheWrite,
    p_usd: u.usd,
  });
  if (error) throw new Error(`usage: ${error.message}`);
  spendAlarmInBackground(); // never blocks or throws
}
