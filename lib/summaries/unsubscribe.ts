import "server-only";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyUnsubscribeToken } from "./token";

// "Avsluta prenumeration" in a summary e-mail (0037). The signed link names one person; it stops
// that person's summaries in every mode. Service role (no sign-in: most people have no account).

export interface UnsubscribeTarget {
  orgName: string;
  unsubscribed: boolean;
}

/** The person's förening and whether they already unsubscribed; null for a bad or stale link. */
export async function lookupUnsubscribe(token: string | null | undefined): Promise<UnsubscribeTarget | null> {
  const personId = verifyUnsubscribeToken(getEnv().TOKEN_ENC_KEY, token);
  if (!personId) return null;
  const { data, error } = await supabaseAdmin()
    .from("people")
    .select("summary_unsubscribed_at, orgs(name)")
    .eq("id", personId)
    .maybeSingle();
  if (error) throw new Error(`unsubscribe: read: ${error.message}`);
  if (!data) return null;
  const org = (data as { orgs: { name: string } | { name: string }[] | null }).orgs;
  const orgName = Array.isArray(org) ? (org[0]?.name ?? "") : (org?.name ?? "");
  return { orgName, unsubscribed: Boolean((data as { summary_unsubscribed_at: string | null }).summary_unsubscribed_at) };
}

/** Unsubscribe the link's person (idempotent). False for a bad link or a person that is gone. */
export async function unsubscribe(token: string | null | undefined, now = new Date()): Promise<boolean> {
  const personId = verifyUnsubscribeToken(getEnv().TOKEN_ENC_KEY, token);
  if (!personId) return false;
  const db = supabaseAdmin();
  const { data, error } = await db.from("people").select("id, summary_unsubscribed_at").eq("id", personId).maybeSingle();
  if (error) throw new Error(`unsubscribe: read: ${error.message}`);
  if (!data) return false;
  if (!data.summary_unsubscribed_at) {
    const { error: ue } = await db.from("people").update({ summary_unsubscribed_at: now.toISOString() }).eq("id", personId);
    if (ue) throw new Error(`unsubscribe: update: ${ue.message}`);
  }
  return true;
}
