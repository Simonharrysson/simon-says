import "server-only";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { mayOpenAdmin } from "./gate";
import { parseOrgRows, parseOverview, type AdminOrgRow, type AdminOverview } from "./stats";

export class NotAdminError extends Error {
  constructor() {
    super("not an admin");
  }
}

/**
 * The dashboard's data, read with the service role. The gate is checked here, before any
 * service-role call, so no caller can reach the data without it.
 */
export async function loadAdminDashboard(email: string | null | undefined): Promise<{ overview: AdminOverview; orgs: AdminOrgRow[] }> {
  if (!mayOpenAdmin(email, getEnv())) throw new NotAdminError();
  const db = supabaseAdmin();
  const [overview, orgs] = await Promise.all([db.rpc("admin_overview"), db.rpc("admin_org_stats")]);
  if (overview.error) throw new Error(`admin_overview: ${overview.error.message}`);
  if (orgs.error) throw new Error(`admin_org_stats: ${orgs.error.message}`);
  return { overview: parseOverview(overview.data), orgs: parseOrgRows(orgs.data) };
}
