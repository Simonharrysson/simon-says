import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanContextName, findByName, sortContexts, type ContextRow } from "./contexts";

// Contexts in the database, as the signed-in user (RLS: members of the space only).

export async function listContexts(db: SupabaseClient, orgId: string): Promise<ContextRow[]> {
  const { data, error } = await db.from("contexts").select("id, name, created_at, last_used_at").eq("org_id", orgId);
  if (error) throw new Error(`contexts: ${error.message}`);
  return sortContexts((data ?? []) as ContextRow[]);
}

export type CreateContextResult = { ok: true; context: ContextRow } | { ok: false; reason: "invalid" | "failed" };

/** A new context, or the existing one with the same name (case-insensitive). */
export async function createContext(db: SupabaseClient, orgId: string, rawName: unknown): Promise<CreateContextResult> {
  const name = cleanContextName(rawName);
  if (!name) return { ok: false, reason: "invalid" };
  const existing = findByName(await listContexts(db, orgId), name);
  if (existing) return { ok: true, context: existing };
  const { data, error } = await db.from("contexts").insert({ org_id: orgId, name }).select("id, name, created_at, last_used_at").single();
  if (error) {
    // Two tabs creating the same name: the unique index (org, lower(name)) picks one.
    if (error.code === "23505") {
      const again = findByName(await listContexts(db, orgId), name);
      if (again) return { ok: true, context: again };
    }
    console.error(`contexts: create failed: ${error.code ?? error.message}`);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, context: data as ContextRow };
}

/** Deletes the context and, by cascade, its meetings, summaries and tasks (refused while one runs). */
export async function deleteContext(db: SupabaseClient, contextId: string): Promise<"deleted" | "not_deleted"> {
  const { data, error } = await db.from("contexts").delete().eq("id", contextId).select("id");
  if (error) throw new Error(`contexts: delete: ${error.message}`);
  return data?.length ? "deleted" : "not_deleted";
}
