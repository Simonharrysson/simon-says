import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgRow } from "@/lib/db/types";

// The user's Privat space (0045): an org of kind 'privat' with the user as its only member,
// created on first use. Hidden from the förening list (lib/db/orgs.ts listMyOrgs), never
// joinable, and its own pages live under /privat.

/** The signed-in user's Privat space id, created if missing (as the user: security definer). */
export async function ensurePrivatSpace(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.rpc("ensure_my_privat_space");
  if (error || typeof data !== "string") throw new Error(`privat space: ${error?.message ?? "no id"}`);
  return data;
}

export function isPrivat(org: Pick<OrgRow, "kind"> | null | undefined): boolean {
  return org?.kind === "privat";
}

/** Where the "back" link of a Privat recording goes. */
export function privatHref(contextId?: string | null): string {
  return contextId ? `/privat/${contextId}` : "/privat";
}
