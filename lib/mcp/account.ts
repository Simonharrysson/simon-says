import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirectAudience, type Audience } from "./oauth";

// Konto → Koppla till din AI: the user's own grants and recent audit rows, read with their
// own client (RLS: own rows only). A database without 0060 reads as "none".

export interface ConnectionRow {
  id: string;
  /** The name the client registered: its own claim, shown only as secondary text. */
  client_name: string;
  created_at: string;
  last_used_at: string | null;
  /** The app, from the redirect URI the grant was approved for (0068); "unknown" when not recorded. */
  app: Audience;
}

/** The app a grant goes to, from its redirect URI (the consent page's rule), never from the client's name. */
export const appOfRedirect = (uri: string | null | undefined): Audience => (uri ? redirectAudience(uri).kind : "unknown");

export interface AuditEntry {
  id: number;
  tool: string;
  ok: boolean;
  at: string;
}

export const AUDIT_SHOWN = 20;

const missing = (code: string | undefined) => code === "42P01" || code === "PGRST205";

export async function loadConnections(db: SupabaseClient): Promise<{ connections: ConnectionRow[]; audit: AuditEntry[] }> {
  const grantsOf = (columns: string) => db.from("mcp_grants").select(columns).is("revoked_at", null).order("created_at", { ascending: false });
  let [grants, audit] = await Promise.all([
    grantsOf("id, client_name, created_at, last_used_at, redirect_uri"),
    db.from("mcp_audit").select("id, tool, ok, at").order("at", { ascending: false }).limit(AUDIT_SHOWN),
  ]);
  // Before 0068 there is no redirect_uri: the list still shows, with neutral icons.
  if (grants.error?.code === "42703") grants = await grantsOf("id, client_name, created_at, last_used_at");
  for (const r of [grants, audit]) {
    if (r.error && !missing(r.error.code)) console.error(`mcp account: ${r.error.message}`);
  }
  return {
    connections: (grants.error ? [] : ((grants.data ?? []) as unknown as (Omit<ConnectionRow, "app"> & { redirect_uri: string | null })[])).map(
      ({ redirect_uri, ...g }) => ({ ...g, app: appOfRedirect(redirect_uri) }),
    ),
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
