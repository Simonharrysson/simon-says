import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Inför möten (0059): the opt-in for FÖRENING briefs (user_settings.brief_foreningar, default
// off). Företag briefs need only the meeting_brief category (default on).

/** The signed-in user's choice (RLS: own row); false when none is saved or it can't be read. */
export async function loadMyBriefForeningar(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
    return !error && (data as { brief_foreningar?: unknown } | null)?.brief_foreningar === true;
  } catch {
    return false;
  }
}

/** Konto → Mejl: saves the choice (set_my_brief_foreningar: own row only). */
export async function saveMyBriefForeningar(db: SupabaseClient, on: boolean): Promise<boolean> {
  const { error } = await db.rpc("set_my_brief_foreningar", { p_on: on });
  if (error) console.error(`brief: saving the opt-in failed: ${error.code ?? error.message}`);
  return !error;
}
