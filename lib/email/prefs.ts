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
  return (await checkEmailGate(recipient, category, db)) === "allowed";
}

/**
 * The gate's answers: "unknown" = the database could not answer (retry later, don't record a no);
 * "invalid" = no usable address or account (permanent: retrying can't help).
 */
export async function checkEmailGate(
  recipient: Recipient,
  category: EmailCategory,
  db: SupabaseClient = supabaseAdmin(),
): Promise<"allowed" | "opted_out" | "unknown" | "invalid"> {
  const email = recipient.email ? cleanEmail(recipient.email) : null;
  if (!recipient.userId && !email) return "invalid";
  const { data, error } = await db.rpc("may_email", {
    p_user_id: recipient.userId ?? null,
    p_email: email,
    p_category: category,
  });
  if (error || typeof data !== "boolean") {
    console.error(`mail: preference check failed (${category}): ${error?.code ?? error?.message ?? "no answer"}`);
    return "unknown";
  }
  return data ? "allowed" : "opted_out";
}

export type UserMailResult = "sent" | "opted_out" | "invalid" | "failed";

/**
 * The gate plus the send. "opted_out" means the recipient said no (final: don't retry);
 * "failed" means nothing went out, either the provider refused or the preference check could not
 * be answered (retry like any failed send); "invalid" means the address is unusable (permanent).
 */
export async function sendUserMail(
  mailer: Mailer,
  recipient: Recipient & { email: string },
  category: EmailCategory,
  message: Omit<MailMessage, "to">,
  db: SupabaseClient = supabaseAdmin(),
): Promise<UserMailResult> {
  const gate = await checkEmailGate(recipient, category, db);
  if (gate === "opted_out" || gate === "invalid") return gate;
  if (!cleanEmail(recipient.email)) return "invalid";
  if (gate === "unknown") return "failed";
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

/** One-click unsubscribe: one category off for that address, atomically in the database. */
export async function unsubscribeCategory(email: string, category: EmailCategory, db: SupabaseClient = supabaseAdmin()): Promise<boolean> {
  const clean = cleanEmail(email);
  if (!clean) return false;
  const { error } = await db.rpc("unsubscribe_email_category", { p_email: clean, p_category: category });
  if (error) console.error(`mail: unsubscribe failed (${category}): ${error.code ?? error.message}`);
  return !error;
}
