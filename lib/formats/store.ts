import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseProfile, type FormatKind, type FormatProfile } from "./schema";
import { ENKEL, STANDARD } from "./standard";

/** The org's default format; no default row (or an unreadable one) means Enkel. */
export async function orgDefaultFormat(
  db: SupabaseClient,
  orgId: string,
): Promise<{ id: string | null; profile: FormatProfile }> {
  const { data, error } = await db
    .from("format_profiles")
    .select("id, profile")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw new Error(`orgDefaultFormat: ${error.message}`);
  const profile = data ? parseProfile(data.profile) : null;
  return data && profile ? { id: data.id as string, profile } : { id: null, profile: ENKEL };
}

/** Service role: a stored profile by id (meetings keep `format_profile_id`). */
export async function formatById(id: string): Promise<FormatProfile | null> {
  const { data, error } = await supabaseAdmin().from("format_profiles").select("profile").eq("id", id).maybeSingle();
  if (error) throw new Error(`formatById: ${error.message}`);
  return data ? parseProfile(data.profile) : null;
}

export async function listOrgFormats(
  db: SupabaseClient,
  orgId: string,
): Promise<{ id: string; kind: FormatKind; isDefault: boolean; createdAt: string }[]> {
  const { data, error } = await db
    .from("format_profiles")
    .select("id, kind, is_default, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listOrgFormats: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as FormatKind,
    isDefault: r.is_default as boolean,
    createdAt: r.created_at as string,
  }));
}

/** Admin only (the DB function checks): makes a new version of a standard format the default. */
export async function chooseStandardFormat(
  db: SupabaseClient,
  orgId: string,
  kind: "veckomote" | "styrelseprotokoll" | "enkel",
): Promise<string> {
  const { data, error } = await db.rpc("set_default_format", {
    p_org_id: orgId,
    p_kind: kind,
    p_profile: STANDARD[kind],
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as string;
}

/** Admin only: re-adopt an earlier version of this org's formats. */
export async function adoptFormat(db: SupabaseClient, orgId: string, profileId: string): Promise<void> {
  const { error } = await db.rpc("set_default_format_id", { p_org_id: orgId, p_profile_id: profileId });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
}
