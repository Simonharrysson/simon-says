import { after, NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { checkLimits } from "@/lib/limits";
import { endMeeting } from "@/lib/meetings/tick";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// The automatic end (final notes pass) runs after the response.
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Starter's browser pings this; it only sets last_heartbeat_at. Answers `{ warn, stop }` from
 * checkLimits (also under the kill switch, where stop is true), plus what the live page shows
 * `minutesLeft` while warning, and about the Doc: `docPaused` (Google access lost) and
 * `lastTickOkAt` (last notes write).
 *
 * Stop = the meeting must end now (4 h per meeting, org month, global day/dollar cap, kill
 * switch). The server does not rely on the browser: on stop it ends the meeting itself, after
 * the response (endMeeting is atomic live → ending, so the client's own end call and repeated
 * heartbeats are no-ops). `no_consent` is excluded: that meeting never started recording.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, org_id, started_by, status, doc_paused_at, last_tick_ok_at, current_el_session_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`heartbeat: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);
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
      lastTickOkAt: meeting.last_tick_ok_at ?? null,
      // The session the server considers current: a tab whose session isn't it stops (another tab took over).
      currentElSessionId: meeting.current_el_session_id ?? null,
    },
    { headers: noStore },
  );
}
