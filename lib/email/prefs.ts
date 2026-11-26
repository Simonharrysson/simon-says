import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mailer, MailMessage } from "@/lib/mail";
import { cleanEmail } from "@/lib/people/board";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ALL_ON, cleanOff, type EmailCategory, type EmailPrefs } from "./categories";

// The one gate for user-facing mail (0039). Every send to a user or a person goes through
// mayEmail() (or sendUserMail(), which calls it), by user id when known, by address otherwise,
// best both. The database merges the account's choices and the address's (the signed link), so a
// "never e-mail me" from an address holds even before that person has an account.
//
// No stored choice = allowed. That is the transactional exception: a first invite to an address
// that has never said no goes out; one that said "Inga mejl alls" (or no to invites) does not.
//
// Fails closed: if the database can't answer, nothing is sent.

export interface Recipient {
  /** Account id, when the recipient has one (people.member_user_id, org_members.user_id). */
  userId?: string | null;
  /** The address the mail goes to. */
  email?: string | null;
}

export async function mayEmail(
  recipient: Recipient,
  category: EmailCategory,
  db: SupabaseClient = supabaseAdmin(),
): Promise<boolean> {
  const email = recipient.email ? cleanEmail(recipient.email) : null;
  if (!recipient.userId && !email) return false;
  const { data, error } = await db.rpc("may_email", {
    p_user_id: recipient.userId ?? null,
    p_email: email,
    p_category: category,
  });
  if (error) {
    console.error(`mail: preference check failed (${category}): ${error.code ?? error.message}`);
    return false;
  }
  return data === true;
}

export type UserMailResult = "sent" | "opted_out" | "failed";

/**
 * The gate plus the send. "opted_out" means nothing was handed to the provider because the
 * recipient said no; callers record it like any other outcome.
 */
export async function sendUserMail(
  mailer: Mailer,
  recipient: Recipient & { email: string },
  category: EmailCategory,
  message: Omit<MailMessage, "to">,
  db: SupabaseClient = supabaseAdmin(),
): Promise<UserMailResult> {
  if (!(await mayEmail(recipient, category, db))) return "opted_out";
  try {
    return (await mailer.send({ ...message, to: recipient.email })) ? "sent" : "failed";
  } catch (e) {
    console.error(`mail: send failed (${category}): ${(e as Error).name}`);
    return "failed";
  }
}

/** What applies to a recipient (both rows merged), for the settings and unsubscribe pages. */
export async function loadEmailPrefs(recipient: Recipient, db: SupabaseClient = supabaseAdmin()): Promise<EmailPrefs | null> {
  const { data, error } = await db.rpc("email_preferences_for", {
    p_user_id: recipient.userId ?? null,
    p_email: recipient.email ? cleanEmail(recipient.email) : null,
  });
  if (error) {
    console.error(`mail: loading preferences failed: ${error.code ?? error.message}`);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { all_off?: boolean; off_categories?: string[] } | undefined;
  if (!row) return ALL_ON;
  return { allOff: row.all_off === true, off: cleanOff(row.off_categories ?? []) };
}

/** Konto → Mejl, as the signed-in user (their own row; RLS + security definer). */
export async function saveMyEmailPrefs(userDb: SupabaseClient, prefs: EmailPrefs): Promise<boolean> {
  const { error } = await userDb.rpc("set_my_email_preferences", {
    p_all_off: prefs.allOff,
    p_off_categories: cleanOff(prefs.off),
  });
  if (error) console.error(`mail: saving preferences failed: ${error.code ?? error.message}`);
  return !error;
}

/** The unsubscribe page / one-click endpoint, after the signed link was checked. */
export async function saveAddressEmailPrefs(email: string, prefs: EmailPrefs, db: SupabaseClient = supabaseAdmin()): Promise<boolean> {
  const clean = cleanEmail(email);
  if (!clean) return false;
  const { error } = await db.rpc("set_email_preferences_for_address", {
    p_email: clean,
    p_all_off: prefs.allOff,
    p_off_categories: cleanOff(prefs.off),
  });
  if (error) console.error(`mail: saving address preferences failed: ${error.code ?? error.message}`);
  return !error;
}
