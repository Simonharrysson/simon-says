import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Emails of the org's members, oldest member first. Service role: reads auth.users. */
export async function memberEmails(orgId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc("member_emails", { p_org_id: orgId });
  if (error) throw new Error(`memberEmails: ${error.message}`);
  return (data ?? []) as string[];
}

export interface OrgMember {
  userId: string;
  email: string;
  role: "admin" | "member";
}

/** The org's members with role, oldest member first. Service role: reads auth.users. */
export async function orgMemberList(orgId: string): Promise<OrgMember[]> {
  const { data, error } = await supabaseAdmin().rpc("org_member_list", { p_org_id: orgId });
  if (error) throw new Error(`orgMemberList: ${error.message}`);
  return ((data ?? []) as { user_id: string; email: string | null; role: "admin" | "member" }[]).map((r) => ({
    userId: r.user_id,
    email: r.email ?? "",
    role: r.role,
  }));
}
