import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MailMessage, Mailer } from "@/lib/mail";
import { checkEmailGate, sendUserMailDetailed } from "@/lib/email/prefs";
import { localeForEmail } from "@/lib/i18n/user-locale";
import { inviteEmail, linkLikeName } from "./email";
import { INVITE_LIMITS, type InviteResult, type InviteRow, type InviteStatus } from "./rules";

// Sends invite e-mails (0038). Every address is claimed in the database first (limits, members,
// the 24 h resend rule), then sent, then recorded. Takes the service-role client and a Mailer, so
// tests pass a fake. Never logs an address: only counts and Resend's status (lib/mail.ts logs the
// subject, which holds the inviter's name and the förening, never an address).

export interface SendInvitesInput {
  orgId: string;
  userId: string;
  inviterName: string;
  /** The admin's sign-in address: the e-mail's Reply-To. */
  inviterEmail: string | null;
  orgName: string;
  inviteUrl: string;
  /** Already cleaned and deduplicated (parseEmails). */
  emails: string[];
  resend: boolean;
}

export interface SendInvitesDeps {
  db: SupabaseClient;
  mailer: Mailer;
  /** Pause between sends (Resend allows a few requests a second). */
  gapMs?: number;
  /** Stop starting sends after this long (default 40 s); the rest are `not_sent`. */
  deadlineMs?: number;
  /** Per recipient: the signed mail-settings link and List-Unsubscribe headers (lib/email/token.ts). */
  links?: { prefsUrl(email: string): string; headers(email: string): Record<string, string> };
}

export interface AddressResult {
  email: string;
  result: InviteResult;
  /** resend_limit: when it opens again. */
  nextAt?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends at once (Resend allows a few requests a second). */
const CONCURRENCY = 2;
/** Stop starting sends after this long: with the mailer's 10 s timeout the request ends inside 60 s. */
const DEADLINE_MS = 40_000;

export async function sendInvites(input: SendInvitesInput, deps: SendInvitesDeps): Promise<AddressResult[]> {
  // Defence in depth: the route refuses these with a sentence first (I1: no links in our mail).
  if (linkLikeName(input.inviterName, input.orgName)) throw Object.assign(new Error("invite: a name looks like a link"), { code: "name_link" });
  const base = { inviterName: input.inviterName, orgName: input.orgName, inviteUrl: input.inviteUrl };
  inviteEmail(base); // throws on a bad link before anything is claimed
  const emails = input.emails.slice(0, INVITE_LIMITS.perRequest);
  const results: AddressResult[] = new Array(emails.length);
  const gap = deps.gapMs ?? 300;
  const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS);
  let next = 0;

  async function one(email: string): Promise<AddressResult> {
    // The mail-settings gate first (0039), so an address that said no never uses up the limits.
    const gate = await checkEmailGate({ email }, "invite", deps.db);
    if (gate === "opted_out" || gate === "invalid") return { email, result: gate };
    if (gate === "unknown") return { email, result: "failed" };
    const { data, error } = await deps.db.rpc("claim_invite_send", {
      p_org_id: input.orgId,
      p_user_id: input.userId,
      p_email: email,
      p_resend: input.resend,
      p_org_limit: INVITE_LIMITS.perOrgPerDay,
      p_user_limit: INVITE_LIMITS.perUserPerDay,
      p_address_limit: INVITE_LIMITS.perAddressPerDay,
    });
    if (error) throw new Error(`claim_invite_send: ${error.message}`);
    const claim = data as { result: string; send_id?: number; idem_key?: string; next_at?: string };
    if (claim.result === "forbidden") throw Object.assign(new Error("claim_invite_send: forbidden"), { code: "42501" });
    if (claim.result !== "ok" || claim.send_id === undefined) {
      return { email, result: claim.result as InviteResult, ...(claim.next_at ? { nextAt: claim.next_at } : {}) };
    }
    // In the recipient's language when their account has chosen one (Swedish otherwise).
    const locale = await localeForEmail(email, deps.db);
    const message = inviteEmail({ ...base, locale, ...(deps.links ? { prefsUrl: deps.links.prefsUrl(email) } : {}) });
    const mail: Omit<MailMessage, "to"> = {
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(input.inviterEmail ? { replyTo: input.inviterEmail } : {}),
      // The same key on a retry of an uncertain send: Resend never delivers it twice.
      ...(claim.idem_key ? { idempotencyKey: claim.idem_key } : {}),
      ...(deps.links ? { headers: deps.links.headers(email) } : {}),
    };
    // Through the gate (it checks again: a "no" saved since the check above still holds).
    const sent = await sendUserMailDetailed(deps.mailer, { email }, "invite", mail, deps.db);
    const outcome = sent === "sent" || sent === "uncertain" ? sent : "failed";
    const { error: finishError } = await deps.db.rpc("finish_invite_send", { p_send_id: claim.send_id, p_outcome: outcome });
    if (finishError) console.error(`finish_invite_send: ${finishError.message}`.slice(0, 200));
    return { email, result: sent };
  }

  async function worker(first: boolean) {
    let started = false;
    while (next < emails.length) {
      const i = next++;
      if (Date.now() > deadline) {
        results[i] = { email: emails[i], result: "not_sent" };
        continue;
      }
      if ((started || !first) && gap > 0) await sleep(gap);
      started = true;
      results[i] = await one(emails[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emails.length) }, (_, w) => worker(w === 0)));

  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {});
  console.info(`invites: org ${input.orgId}: ${JSON.stringify(counts)}`);
  return results;
}

/** The förening's invites, newest first (service role; call only after an admin check). */
export async function listInvites(db: SupabaseClient, orgId: string): Promise<InviteRow[]> {
  const { data, error } = await db.rpc("org_invite_list", { p_org_id: orgId });
  if (error) throw new Error(`org_invite_list: ${error.message}`);
  return ((data ?? []) as { email: string; status: InviteStatus; last_sent_at: string | null; accepted_at: string | null; recent_sends: number; next_resend_at: string | null; last_attempt_at: string | null }[]).map((r) => ({
    email: r.email,
    status: r.status,
    lastSentAt: r.last_sent_at,
    acceptedAt: r.accepted_at,
    recentSends: r.recent_sends,
    nextResendAt: r.next_resend_at,
    lastAttemptAt: r.last_attempt_at,
  }));
}

/**
 * The name the e-mail says invites: the admin's name in the förening's list, then their Google
 * name, then a neutral word. Never the e-mail address (it would end up in the subject).
 */
export function inviterNameFor(personName: string | null | undefined, metadata: Record<string, unknown> | undefined): string {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() && !v.includes("@") ? v.trim().slice(0, 100) : null);
  return pick(personName) ?? pick(metadata?.full_name) ?? pick(metadata?.name) ?? "En administratör";
}
