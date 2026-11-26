"use server";

import { cleanOff, type EmailPrefs } from "@/lib/email/categories";
import { saveAddressEmailPrefs } from "@/lib/email/prefs";
import { checkEmailPrefsToken } from "@/lib/email/token";

/** /mejl: saves the choices for the address the signed link names (no login). */
export async function saveLinkEmailPrefsAction(token: string, prefs: EmailPrefs): Promise<boolean> {
  const email = checkEmailPrefsToken(token);
  if (!email) return false;
  if (typeof prefs !== "object" || prefs === null || typeof prefs.allOff !== "boolean" || !Array.isArray(prefs.off)) {
    return false;
  }
  return saveAddressEmailPrefs(email, { allOff: prefs.allOff, off: cleanOff(prefs.off) });
}
