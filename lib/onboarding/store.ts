import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStepId, markStep, type OnboardingState, type StepId } from "./steps";

// The förening's onboarding row (0035), read and written as the signed-in user: members read,
// admins write (RLS). No row (a förening from before onboarding) → null: no card.

export async function loadOnboarding(db: SupabaseClient, orgId: string): Promise<OnboardingState | null> {
  const { data, error } = await db
    .from("org_onboarding")
    .select("done, skipped, completed_at, dismissed_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // Before 0035 is applied the table is missing: no onboarding, never a broken page.
    console.error(`onboarding: load: ${error.message}`.slice(0, 200));
    return null;
  }
  if (!data) return null;
  return {
    done: ((data.done as string[]) ?? []).filter(isStepId),
    skipped: ((data.skipped as string[]) ?? []).filter(isStepId),
    completedAt: (data.completed_at as string | null) ?? null,
    dismissedAt: (data.dismissed_at as string | null) ?? null,
  };
}

async function save(db: SupabaseClient, orgId: string, s: OnboardingState): Promise<boolean> {
  const { data, error } = await db
    .from("org_onboarding")
    .update({ done: s.done, skipped: s.skipped, completed_at: s.completedAt, dismissed_at: s.dismissedAt, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .select("org_id");
  if (error) throw new Error(`onboarding: save: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Marks a step done or skipped (admins). Null when there is no row or the user may not. */
export async function recordStep(db: SupabaseClient, orgId: string, step: StepId, how: "done" | "skipped"): Promise<OnboardingState | null> {
  const current = await loadOnboarding(db, orgId);
  if (!current) return null;
  const next = markStep(current, step, how, new Date().toISOString());
  return (await save(db, orgId, next)) ? next : null;
}

/** Hides the "Kom igång" card (dismissed) or shows it again (null). */
export async function setDismissed(db: SupabaseClient, orgId: string, dismissed: boolean): Promise<boolean> {
  const current = await loadOnboarding(db, orgId);
  if (!current) return false;
  return save(db, orgId, { ...current, dismissedAt: dismissed ? new Date().toISOString() : null });
}
