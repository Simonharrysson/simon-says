import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Emails of the org's members, oldest member first. Service role: reads auth.users. */
export async function memberEmails(orgId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc("member_emails", { p_org_id: orgId });
  if (error) throw new Error(`memberEmails: ${error.message}`);
  return (data ?? []) as string[];
}
