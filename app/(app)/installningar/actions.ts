"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cleanOff, type EmailPrefs } from "@/lib/email/categories";
import { saveMyEmailPrefs } from "@/lib/email/prefs";
import { saveMyBriefForeningar } from "@/lib/brief/prefs";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/i18n/config";
import { saveMyLocale } from "@/lib/i18n/user-locale";
import { isUuid } from "@/lib/db/ids";
import { revokeConnection } from "@/lib/mcp/account";
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

/** Konto → Mejl → "Även inför föreningsmöten" (Inför möten, 0059): the user's own opt-in. */
export async function saveBriefForeningarAction(on: boolean): Promise<boolean> {
  if (typeof on !== "boolean") return false;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return false;
  return saveMyBriefForeningar(db, on);
}

/**
 * Konto → Språk / Language: the `lang` cookie (what the pages render in) and the account's saved
 * choice (e-mails, other browsers). The cookie is set even if the database write fails; the page
 * then says the account didn't get it (`?fel=sprak`).
 */
export async function saveLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (!isLocale(locale)) redirect("/installningar");
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
  const ok = await saveMyLocale(db, locale);
  redirect(ok ? "/installningar" : "/installningar?fel=sprak");
}

/** Konto → Koppla till din AI → Koppla från (the user's own grant only: revoke_mcp_grant). */
export async function revokeConnectionAction(formData: FormData): Promise<void> {
  const id = formData.get("grant");
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const ok = typeof id === "string" && isUuid(id) && (await revokeConnection(db, id));
  // The redirect differs from the page only by its #hash, which the router treats as a scroll:
  // without this the list would still show the connection that was just removed.
  revalidatePath("/installningar");
  redirect(ok ? "/installningar#ai" : "/installningar?fel=aterkalla#ai");
}
