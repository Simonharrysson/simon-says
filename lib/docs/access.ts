import "server-only";
import type { OAuth2Client } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shareWith } from "@/lib/docs/create";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Who can open a meeting's Doc (migration 0030, `meeting_doc_shares`). We don't ask Google per
// page view (one Drive call per meeting and member, and under drive.file a member's own token is
// not expected to see a Doc it neither created nor picked; not measured), so access is what Simon
// Says recorded: the starter owns or picked the Doc, every other member has a row once we shared
// it with them (at the start, when they joined, or when they asked on the org page).
// Shares always go through the STARTER's grant: the Doc's owner, the only one who may share a Doc
// we created (writersCanShare=false). The starter must still be a member of the förening. An
// agenda Doc (the förening's own) is shared only when a member asks ("Få åtkomst"), never on join.
// Logs carry ids only, never emails or Doc names.

/** A table this database doesn't have yet (code deployed before 0030). */
const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

/** Records that the meeting's Doc was shared with these members. Best effort: logged, never thrown. */
export async function recordDocShares(meetingId: string, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const rows = userIds.map((user_id) => ({ meeting_id: meetingId, user_id }));
  const { error } = await supabaseAdmin().from("meeting_doc_shares").upsert(rows, { onConflict: "meeting_id,user_id", ignoreDuplicates: true });
  if (error) {
    if (missingTable(error.code)) console.warn("meeting_doc_shares missing (0030 not applied); share not recorded");
    else console.error(`meetings ${meetingId}: record doc shares: ${error.message}`);
  }
}

/**
 * The meetings whose Doc was shared with the signed-in user (RLS: own rows only, so no id filter:
 * a long `in (…)` list could fail and turn every row into "Få åtkomst"). A database without 0030
 * gives an empty set (everyone then sees "Få åtkomst").
 */
export async function sharedMeetingIds(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db.from("meeting_doc_shares").select("meeting_id");
  if (error) {
    if (!missingTable(error.code)) console.error(`meeting_doc_shares: read: ${error.message}`);
    return new Set();
  }
  return new Set(((data ?? []) as { meeting_id: string }[]).map((r) => r.meeting_id));
}

interface ShareableMeeting {
  id: string;
  org_id: string;
  doc_id: string;
  started_by: string | null;
  agenda_doc: boolean;
}

export type ShareOutcome =
  /** Shared now (or it already was). */
  | "shared"
  /** The starter is gone (left the förening, account deleted) or never recorded. */
  | "no_starter"
  /** The starter's Google connection has lapsed. */
  | "starter_google_lost"
  /** Google refused (e.g. not a Google account) or was unreachable. */
  | "failed";

/** One share through the starter's grant, recorded on success. */
async function shareOne(auth: OAuth2Client, meeting: ShareableMeeting, user: { id: string; email: string }): Promise<ShareOutcome> {
  try {
    await shareWith(auth, meeting.doc_id, user.email);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return "starter_google_lost";
    console.error(`meetings ${meeting.id}: share with member ${user.id} failed: ${(err as Error).message}`);
    return "failed";
  }
  await recordDocShares(meeting.id, [user.id]);
  return "shared";
}

/** The ones of `userIds` that are still members of the förening (service role). */
async function stillMembers(orgId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { data, error } = await supabaseAdmin().from("org_members").select("user_id").eq("org_id", orgId).in("user_id", userIds);
  if (error) throw new Error(`doc shares: members: ${error.message}`);
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

/**
 * Share one meeting's Doc with a member who asked (the org page), agenda Docs included (the
 * starter picked it; Google refuses if their account may not share it). The caller has checked,
 * as the user, that they are a member of the meeting's förening. `user.email` is their sign-in
 * address. A starter who has left the förening is never used.
 */
export async function shareMeetingDocWith(meeting: ShareableMeeting, user: { id: string; email: string }): Promise<ShareOutcome> {
  if (!meeting.started_by) return "no_starter";
  if (meeting.started_by === user.id) return "shared";
  if (!(await stillMembers(meeting.org_id, [meeting.started_by])).has(meeting.started_by)) return "no_starter";
  let auth: OAuth2Client;
  try {
    auth = await getGoogleAuth(meeting.started_by);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return "starter_google_lost";
    console.error(`meetings ${meeting.id}: starter auth: ${(err as Error).message}`);
    return "failed";
  }
  return shareOne(auth, meeting, user);
}

/** The most meetings shared on one join (newest first); older ones can be asked for on the org page. */
export const JOIN_SHARE_LIMIT = 60;

/**
 * A member just joined: share the förening's earlier meeting Docs with them, through each
 * starter's own grant (starters still in the förening; agenda Docs excepted: those only on request;
 * ones already shared skipped). Runs after the join response (`after`), best effort: returns how
 * many were shared.
 */
export async function shareOrgDocsWithNewMember(orgId: string, user: { id: string; email: string }): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("meetings")
    .select("id, org_id, doc_id, started_by, agenda_doc")
    .eq("org_id", orgId)
    .eq("agenda_doc", false)
    .not("started_by", "is", null)
    .neq("started_by", user.id)
    .order("started_at", { ascending: false })
    .limit(JOIN_SHARE_LIMIT);
  if (error) {
    console.error(`join share: meetings: ${error.message}`);
    return 0;
  }
  const all = ((data ?? []) as ShareableMeeting[]).filter((m) => m.doc_id);
  // Only starters still in the förening: someone who left keeps their Drive, not our use of it.
  const members = await stillMembers(orgId, [...new Set(all.map((m) => m.started_by!))]);
  const meetings = all.filter((m) => members.has(m.started_by!));
  const done = await sharedIdsFor(user.id, meetings.map((m) => m.id));

  const byStarter = new Map<string, ShareableMeeting[]>();
  for (const m of meetings) {
    if (done.has(m.id)) continue;
    byStarter.set(m.started_by!, [...(byStarter.get(m.started_by!) ?? []), m]);
  }
  let shared = 0;
  for (const [starter, list] of byStarter) {
    let auth: OAuth2Client;
    try {
      auth = await getGoogleAuth(starter);
    } catch (err) {
      // Their meetings stay "ask" on the org page.
      if (!(err instanceof GoogleAuthLostError)) console.error(`join share: starter auth: ${(err as Error).message}`);
      continue;
    }
    for (const m of list) {
      const outcome = await shareOne(auth, m, user);
      if (outcome === "shared") shared++;
      if (outcome === "starter_google_lost") break;
    }
  }
  return shared;
}

/** Service role: the meetings among `ids` already shared with `userId`. */
async function sharedIdsFor(userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabaseAdmin().from("meeting_doc_shares").select("meeting_id").eq("user_id", userId).in("meeting_id", ids);
  if (error) {
    if (!missingTable(error.code)) console.error(`join share: shares: ${error.message}`);
    return new Set();
  }
  return new Set(((data ?? []) as { meeting_id: string }[]).map((r) => r.meeting_id));
}
