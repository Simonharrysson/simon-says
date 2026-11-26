import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { defaultLocale, isLocale, type Locale } from "./config";

// The saved UI language of an account (user_settings, 0040). Rendering reads the `lang` cookie;
// this is the durable copy: e-mails use it, and sign-in copies it into the cookie.

/** The signed-in user's saved language (RLS: own row), or null when none is saved / unreadable. */
export async function loadMyLocale(db: SupabaseClient, userId: string): Promise<Locale | null> {
  try {
    const { data, error } = await db.from("user_settings").select("locale").eq("user_id", userId).maybeSingle();
    if (error || !data) return null;
    return isLocale(data.locale) ? data.locale : null;
  } catch {
    return null;
  }
}

/** Saves the signed-in user's language (set_my_locale: own row only). */
export async function saveMyLocale(db: SupabaseClient, locale: Locale): Promise<boolean> {
  const { error } = await db.rpc("set_my_locale", { p_locale: locale });
  if (error) console.error(`i18n: saving the language failed: ${error.code ?? error.message}`);
  return !error;
}

/**
 * The language to e-mail an account in: its saved choice, Swedish when unknown (no account, no
 * row, or the read failed: a mail in Swedish beats no mail).
 */
export async function localeForUser(userId: string | null | undefined, db: SupabaseClient = supabaseAdmin()): Promise<Locale> {
  if (!userId) return defaultLocale;
  return (await loadMyLocale(db, userId)) ?? defaultLocale;
}

/** Many accounts at once (meeting summaries): user id → saved language; missing = Swedish. */
export async function localesForUsers(userIds: string[], db: SupabaseClient = supabaseAdmin()): Promise<Map<string, Locale>> {
  const out = new Map<string, Locale>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await db.from("user_settings").select("user_id, locale").in("user_id", ids);
    if (error || !data) return out;
    for (const row of data as { user_id: string; locale: unknown }[]) if (isLocale(row.locale)) out.set(row.user_id, row.locale);
  } catch {
    // Swedish for everyone.
  }
  return out;
}

/**
 * The language to e-mail an address in: the saved choice of the confirmed account that signs in
 * with it (locale_for_email, 0040), Swedish otherwise (no account, no choice, or no answer).
 */
export async function localeForEmail(email: string, db: SupabaseClient = supabaseAdmin()): Promise<Locale> {
  try {
    const { data, error } = await db.rpc("locale_for_email", { p_email: email });
    return !error && isLocale(data) ? data : defaultLocale;
  } catch {
    return defaultLocale;
  }
}
