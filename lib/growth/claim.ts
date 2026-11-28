import "server-only";
import { meetingTitle } from "@/lib/meetings/title";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { maskEmail } from "./recipients";
import { checkInviteToken, inviteIdOf } from "./token";

// The landing after the invite's button (0063). The token only names the invite and carries
// attribution: it never grants access by itself. Access needs a Google-confirmed sign-in with the
// invited address (claim_meeting_invite checks it in the database, in one transaction with the
// link or the grant). A forwarded mail therefore shows the next person nothing but the förening's
// and the meeting's names, and the invited address masked.

/** The cookie that marks a claimed invite for "came back within 7 days" (the (app) layout). */
export const RETURN_COOKIE = "inb";
export const RETURN_COOKIE_MAX_AGE = 7 * 86_400;

export interface InviteLanding {
  id: string;
  orgId: string;
  meetingId: string;
  orgName: string;
  title: string | null;
  startedAt: string;
  /** "o•••@exempel.se". */
  maskedEmail: string;
  email: string;
  starterName: string | null;
  expired: boolean;
  claimedBy: string | null;
}

/** The invite a token names, when the token is ours and bound to its address; else null. */
export async function loadInvite(token: string, now = new Date()): Promise<InviteLanding | null> {
  const id = inviteIdOf(token);
  if (!id) return null;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("meeting_invites")
    .select("id, org_id, meeting_id, email, expires_at, claimed_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`invite: ${error.message}`);
  const inv = data as { id: string; org_id: string; meeting_id: string; email: string | null; expires_at: string; claimed_by: string | null } | null;
  if (!inv || !checkInviteToken(token, inv.id, inv.email)) return null;
  const [org, meeting] = await Promise.all([
    db.from("orgs").select("name").eq("id", inv.org_id).maybeSingle(),
    db.from("meetings").select("started_at, started_by, title, calendar_event, agenda_labels, agenda_roles").eq("id", inv.meeting_id).maybeSingle(),
  ]);
  const m = meeting.data as { started_at: string; started_by: string | null; title: string | null; calendar_event: unknown; agenda_labels: Record<string, string> | null; agenda_roles: Record<string, never> | null } | null;
  if (!org.data || !m) return null;
  const starter = m.started_by
    ? ((await db.from("people").select("name").eq("org_id", inv.org_id).eq("member_user_id", m.started_by).maybeSingle()).data as { name: string } | null)
    : null;
  return {
    id: inv.id,
    orgId: inv.org_id,
    meetingId: inv.meeting_id,
    orgName: (org.data as { name: string }).name,
    title: meetingTitle(m, "och"),
    startedAt: m.started_at,
    maskedEmail: maskEmail(inv.email!),
    email: inv.email!,
    starterName: starter?.name ?? null,
    expired: Date.parse(inv.expires_at) < now.getTime(),
    claimedBy: inv.claimed_by,
  };
}

/**
 * A click: `human` from the landing's beacon (a browser that ran our script), else our redirect
 * (any GET, mail scanners included). First one only; a bad token records nothing.
 */
export async function recordClick(token: string, human: boolean, now = new Date()): Promise<void> {
  const id = inviteIdOf(token);
  if (!id) return;
  const db = supabaseAdmin();
  const { data } = await db.from("meeting_invites").select("id, email").eq("id", id).maybeSingle();
  const inv = data as { id: string; email: string | null } | null;
  if (!inv || !checkInviteToken(token, inv.id, inv.email)) return;
  const column = human ? "clicked_human_at" : "clicked_at";
  const { error } = await db.from("meeting_invites").update({ [column]: now.toISOString() }).eq("id", inv.id).is(column, null);
  if (error) console.error(`invite click: ${error.message}`);
}

export type ClaimOutcome = "ok" | "ok_again" | "mismatch" | "used" | "expired" | "gone" | "invalid";

/** The claim for the signed-in user (the database checks the address). */
export async function claimInvite(
  token: string,
  user: { id: string; created_at?: string | null },
  now = new Date(),
): Promise<{ outcome: ClaimOutcome; orgId?: string; meetingId?: string }> {
  const id = inviteIdOf(token);
  if (!id) return { outcome: "invalid" };
  const db = supabaseAdmin();
  const { data } = await db.from("meeting_invites").select("id, email").eq("id", id).maybeSingle();
  const inv = data as { id: string; email: string | null } | null;
  if (!inv || !checkInviteToken(token, inv.id, inv.email)) return { outcome: "invalid" };
  // A new account: made by this sign-in (the funnel's new_account vs existing_account).
  const fresh = user.created_at ? now.getTime() - Date.parse(user.created_at) < 15 * 60_000 : false;
  const { data: rows, error } = await db.rpc("claim_meeting_invite", { p_invite_id: inv.id, p_user_id: user.id, p_new_account: fresh });
  if (error) throw new Error(`invite claim: ${error.message}`);
  const row = (Array.isArray(rows) ? rows[0] : rows) as { outcome: ClaimOutcome; org_id: string | null; meeting_id: string | null } | undefined;
  if (!row) return { outcome: "gone" };
  return { outcome: row.outcome, orgId: row.org_id ?? undefined, meetingId: row.meeting_id ?? undefined };
}

/** "Came back within 7 days": the first signed-in page view 12 h to 7 days after the claim. */
export async function markInviteReturn(userId: string, now = new Date()): Promise<void> {
  const t = now.getTime();
  const { error } = await supabaseAdmin()
    .from("meeting_invites")
    .update({ returned_at: now.toISOString() })
    .eq("claimed_by", userId)
    .is("returned_at", null)
    .lte("claimed_at", new Date(t - 12 * 3600_000).toISOString())
    .gte("claimed_at", new Date(t - 7 * 86_400_000).toISOString());
  if (error) console.error(`invite return: ${error.message}`);
}
