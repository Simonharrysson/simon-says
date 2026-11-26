import "server-only";
import type { OAuth2Client } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shareWith } from "@/lib/docs/create";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Who can open a meeting's Doc (migration 0030, `meeting_doc_shares`). A member's own Google grant
// can't tell (drive.file: a Doc shared with them is still invisible to our app under their token),
// so access is what Simon Says recorded: the starter owns the Doc, every other member has a row
// once we shared it with them (at the start, when they joined, or when they asked on the org page).
// Shares always go through the STARTER's grant: the Doc's owner, the only one who may share it
// (writersCanShare=false). Agenda Docs are the förening's own: never shared by us.
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
 * The ids of `meetingIds` whose Doc was shared with the signed-in user (RLS: own rows only).
 * A database without 0030 gives an empty set (everyone then sees the "ask" state).
 */
export async function sharedMeetingIds(db: SupabaseClient, meetingIds: string[]): Promise<Set<string>> {
  if (!meetingIds.length) return new Set();
  const { data, error } = await db.from("meeting_doc_shares").select("meeting_id").in("meeting_id", meetingIds);
  if (error) {
    if (!missingTable(error.code)) console.error(`meeting_doc_shares: read: ${error.message}`);
    return new Set();
  }
  return new Set(((data ?? []) as { meeting_id: string }[]).map((r) => r.meeting_id));
}

interface ShareableMeeting {
  id: string;
  doc_id: string;
  started_by: string | null;
  agenda_doc: boolean;
}

export type ShareOutcome =
  /** Shared now (or it already was). */
  | "shared"
  /** The förening's own agenda Doc: we never share it. */
  | "agenda"
  /** The starter is gone (account deleted) or never recorded. */
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

/**
 * Share one meeting's Doc with a member who asked (the org page). The caller has checked, as the
 * user, that they are a member of the meeting's förening. `user.email` is their sign-in address.
 */
export async function shareMeetingDocWith(meeting: ShareableMeeting, user: { id: string; email: string }): Promise<ShareOutcome> {
  if (meeting.agenda_doc) return "agenda";
  if (!meeting.started_by) return "no_starter";
  if (meeting.started_by === user.id) return "shared";
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
 * starter's own grant (agenda Docs excepted; ones already shared skipped). Runs after the join
 * response (`after`), best effort: returns how many were shared.
 */
export async function shareOrgDocsWithNewMember(orgId: string, user: { id: string; email: string }): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("meetings")
    .select("id, doc_id, started_by, agenda_doc")
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
  const meetings = ((data ?? []) as ShareableMeeting[]).filter((m) => m.doc_id);
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
