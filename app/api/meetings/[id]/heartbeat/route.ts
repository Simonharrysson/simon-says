import { driveSubOf } from "@/lib/google/drive-account";
import { after, NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { checkLimits } from "@/lib/limits";
import { endMeeting } from "@/lib/meetings/tick";
import { memberRole } from "@/lib/db/orgs";
import { canRunMeeting } from "@/lib/meetings/access";
import { PRESENCE_TOKEN_HEADER, verifyPresenceToken } from "@/lib/meetings/presence-token";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// The automatic end (final notes pass) runs after the response.
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * The tab running the meeting (any member's) pings this; it sets last_heartbeat_at, the
 * meeting's presence (lib/meetings/presence.ts). Answers `{ warn, stop }` from
 * checkLimits (also under the kill switch, where stop is true), plus what the live page shows
 * `minutesLeft` while warning, and about the Doc: `docPaused` (Google access lost) and
 * `lastTickOkAt` (last notes write).
 *
 * Stop = the meeting must end now (4 h per meeting, org month, global day/dollar cap, kill
 * switch). The server does not rely on the browser: on stop it ends the meeting itself, after
 * the response (endMeeting is atomic live → ending, so the client's own end call and repeated
 * heartbeats are no-ops). `no_consent` is excluded: that meeting never started recording.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isUuid(id)) return fail("not_found", 404);

  const columns = "id, org_id, status, doc_paused_at, last_tick_ok_at, current_el_session_id";
  type Row = { id: string; org_id: string; status: string; doc_paused_at: string | null; last_tick_ok_at: string | null; current_el_session_id: string | null };
  let meeting: Row | null;
  // Signed out (the cookie expired mid-meeting): the tab's presence token still counts, so a
  // tab that is alive is never ended for presence while its user signs in again (review I2).
  let signedOut = false;
  if (user) {
    const { data, error } = await supabase.from("meetings").select(columns).eq("id", id).maybeSingle();
    if (error) throw new Error(`heartbeat: meeting: ${error.message}`);
    if (!data) return fail("not_found", 404);
    if (!canRunMeeting(await memberRole(supabase, data.org_id, user.id))) return fail("not_member", 403);
    meeting = data as Row;
  } else {
    const tokenUser = verifyPresenceToken(getEnv().TOKEN_ENC_KEY, request.headers.get(PRESENCE_TOKEN_HEADER), id, Date.now());
    if (!tokenUser) return fail("unauthenticated", 401);
    const admin = supabaseAdmin();
    const { data, error } = await admin.from("meetings").select(columns).eq("id", id).maybeSingle();
    if (error) throw new Error(`heartbeat: meeting: ${error.message}`);
    // Removed from the förening (or the meeting is gone): the token no longer counts.
    if (!data || !canRunMeeting(await memberRole(admin, data.org_id, tokenUser))) return fail("unauthenticated", 401);
    meeting = data as Row;
    signedOut = true;
  }
  if (meeting.status === "done" || meeting.status === "abandoned") return fail("not_live", 409);

  const { error: ue } = await supabaseAdmin()
    .from("meetings")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", meeting.id);
  if (ue) throw new Error(`heartbeat: update: ${ue.message}`);

  const limits = await checkLimits(meeting.org_id, meeting.id);
  if (limits.stop && limits.reason !== "no_consent") {
    after(() => endMeeting(meeting.id).catch((e) => console.error(`heartbeat: auto end failed: ${(e as Error).message}`)));
  }
  return NextResponse.json(
    {
      warn: limits.warn,
      stop: limits.stop,
      // Minutes until the first cap stops the meeting (the page's "avslutas om N min").
      minutesLeft: limits.warn ? Math.ceil(limits.remainingSeconds / 60) : null,
      // Which cap warns or stops (meeting_length, org_month, global_day, global_usd, kill_switch),
      // so the page can say which limit it is (C9).
      reason: limits.limit ?? null,
      docPaused: Boolean(meeting.doc_paused_at),
      // 0070: paused because the förening's Drive account needs renewing (an admin's job, not a new sign-in).
      ...(meeting.doc_paused_at ? { docPausedForening: Boolean(await driveSubOf("meetings", meeting.id).catch(() => null)) } : {}),
      lastTickOkAt: meeting.last_tick_ok_at ?? null,
      // The session the server considers current: a tab whose session isn't it stops (another tab took over).
      currentElSessionId: meeting.current_el_session_id ?? null,
      // Counted via the presence token: the page still asks the user to sign in again.
      signedOut,
    },
    { headers: noStore },
  );
}
