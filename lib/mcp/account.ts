import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Konto → Kopplade AI-assistenter: the user's own grants and recent audit rows, read with their
// own client (RLS: own rows only). A database without 0060 reads as "none".

export interface ConnectionRow {
  id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface AuditEntry {
  id: number;
  tool: string;
  ok: boolean;
  at: string;
}

export const AUDIT_SHOWN = 20;

const missing = (code: string | undefined) => code === "42P01" || code === "PGRST205";

export async function loadConnections(db: SupabaseClient): Promise<{ connections: ConnectionRow[]; audit: AuditEntry[] }> {
  const [grants, audit] = await Promise.all([
    db.from("mcp_grants").select("id, client_name, created_at, last_used_at").is("revoked_at", null).order("created_at", { ascending: false }),
    db.from("mcp_audit").select("id, tool, ok, at").order("at", { ascending: false }).limit(AUDIT_SHOWN),
  ]);
  for (const r of [grants, audit]) {
    if (r.error && !missing(r.error.code)) console.error(`mcp account: ${r.error.message}`);
  }
  return {
    connections: (grants.error ? [] : grants.data ?? []) as ConnectionRow[],
    audit: (audit.error ? [] : audit.data ?? []) as AuditEntry[],
  };
}

/** Återkalla: the user's own grant (revoke_mcp_grant checks auth.uid()); its tokens stop at once. */
export async function revokeConnection(db: SupabaseClient, grantId: string): Promise<boolean> {
  const { data, error } = await db.rpc("revoke_mcp_grant", { p_grant_id: grantId });
  if (error) {
    console.error(`mcp account: revoke: ${error.message}`);
    return false;
  }
  return data === true;
}
