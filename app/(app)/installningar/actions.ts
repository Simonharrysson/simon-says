"use server";

import { cleanOff, type EmailPrefs } from "@/lib/email/categories";
import { saveMyEmailPrefs } from "@/lib/email/prefs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Konto → Mejl: saves the signed-in user's choices (their own row only). */
export async function saveEmailPrefsAction(prefs: EmailPrefs): Promise<boolean> {
  if (typeof prefs !== "object" || prefs === null || typeof prefs.allOff !== "boolean" || !Array.isArray(prefs.off)) {
    return false;
  }
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return false;
  return saveMyEmailPrefs(db, { allOff: prefs.allOff, off: cleanOff(prefs.off) });
}
