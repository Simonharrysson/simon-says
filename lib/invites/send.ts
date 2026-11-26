import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mailer } from "@/lib/mail";
import { inviteEmail } from "./email";
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
}

export interface AddressResult {
  email: string;
  result: InviteResult;
  /** resend_limit: when it opens again. */
  nextAt?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendInvites(input: SendInvitesInput, deps: SendInvitesDeps): Promise<AddressResult[]> {
  const message = inviteEmail({ inviterName: input.inviterName, orgName: input.orgName, inviteUrl: input.inviteUrl });
  const results: AddressResult[] = [];
  const gap = deps.gapMs ?? 300;
  let sentAny = false;
  for (const email of input.emails.slice(0, INVITE_LIMITS.perRequest)) {
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
    const claim = data as { result: string; send_id?: number; next_at?: string };
    if (claim.result === "forbidden") throw Object.assign(new Error("claim_invite_send: forbidden"), { code: "42501" });
    if (claim.result !== "ok" || claim.send_id === undefined) {
      results.push({ email, result: claim.result as InviteResult, ...(claim.next_at ? { nextAt: claim.next_at } : {}) });
      continue;
    }
    if (sentAny && gap > 0) await sleep(gap);
    sentAny = true;
    const ok = await deps.mailer.send({
      to: email,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(input.inviterEmail ? { replyTo: input.inviterEmail } : {}),
    });
    const { error: finishError } = await deps.db.rpc("finish_invite_send", { p_send_id: claim.send_id, p_ok: ok });
    if (finishError) console.error(`finish_invite_send: ${finishError.message}`.slice(0, 200));
    results.push({ email, result: ok ? "sent" : "failed" });
  }
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {});
  console.info(`invites: org ${input.orgId}: ${JSON.stringify(counts)}`);
  return results;
}

/** The förening's invites, newest first (service role; call only after an admin check). */
export async function listInvites(db: SupabaseClient, orgId: string): Promise<InviteRow[]> {
  const { data, error } = await db.rpc("org_invite_list", { p_org_id: orgId });
  if (error) throw new Error(`org_invite_list: ${error.message}`);
  return ((data ?? []) as { email: string; status: InviteStatus; last_sent_at: string | null; accepted_at: string | null; recent_sends: number; next_resend_at: string | null }[]).map((r) => ({
    email: r.email,
    status: r.status,
    lastSentAt: r.last_sent_at,
    acceptedAt: r.accepted_at,
    recentSends: r.recent_sends,
    nextResendAt: r.next_resend_at,
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
