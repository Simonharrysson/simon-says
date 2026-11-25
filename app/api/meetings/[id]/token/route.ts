import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { claimElSession, releaseUnmintedElSession, type ClaimStatus } from "@/lib/db/usage";
import { devWsOverride, mintToken, realtimeWsUrl } from "@/lib/elevenlabs/token";
import { getEnv } from "@/lib/env";
import { MAX_MINTS_PER_MEETING, mintSpacingSeconds } from "@/lib/limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Refusals from claim_el_session → [HTTP status, error]. 429 `reconnect_limit`: retry after
// 5 s unless the meeting has used its MAX_MINTS_PER_MEETING (14) mints.
const refusal: Record<Exclude<ClaimStatus, "ok">, [number, string]> = {
  not_found: [404, "not_found"],
  not_live: [409, "not_live"],
  busy: [409, "session_open"],
  no_consent: [403, "no_consent"],
  reconnect_limit: [429, "reconnect_limit"],
  global_usd: [429, "global_usd"],
  meeting_length: [429, "meeting_length"],
  org_month: [429, "org_month"],
  global_day: [429, "global_day"],
};

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Mint an ElevenLabs single-use token for the meeting's next transcription session.
 * Body: `{ "closingSessionId"?: string }` — the session whose socket just closed (reconnect).
 * Returns `{ token, wsUrl, sessionId }`; connect to `${wsUrl}&token=${token}`.
 *
 * Only the member who started the meeting, only while it is live and consent is confirmed,
 * at most one mint per 5 s and 14 per meeting, and only while every cap has time left. The
 * whole decision (lock, rate limit, caps, max duration) is made atomically in
 * claim_el_session. The session's max duration is least(time left, 1 h) (Ruling 39); the page
 * rolls over to a new session at the limit. A session's full granted length is booked when it
 * is closed (on the next mint, or by the end/cleanup jobs): ElevenLabs may keep billing an
 * orphaned socket until then.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  // As the user: RLS hides meetings of other orgs (404).
  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, started_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`token: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);
  if (getEnv().KILL_SWITCH) return fail("kill_switch", 503);

  const body = (await request.json().catch(() => null)) as { closingSessionId?: unknown } | null;
  const closing = body?.closingSessionId;
  if (closing !== undefined && closing !== null && (typeof closing !== "string" || closing.length > 200)) {
    return fail("bad_request", 400);
  }
  const closingSessionId = typeof closing === "string" ? closing : null;

  // Claim the session first (atomic: lock, rate limit, caps, closing the previous one), then
  // mint. A failed mint releases the claimed session (nothing booked, not counted toward the
  // mint cap) so a retry is allowed (after the 5 s mint spacing).
  const sessionId = randomUUID();
  const claim = await claimElSession(meeting.id, sessionId, closingSessionId);
  if (claim.status !== "ok") {
    const [status, error] = refusal[claim.status];
    if (claim.status === "busy") {
      // The starter's own open session (e.g. a token response that never reached the browser):
      // tell the starter which one, so the next request can close it instead of waiting.
      const { data: cur } = await supabaseAdmin()
        .from("meetings")
        .select("current_el_session_id")
        .eq("id", meeting.id)
        .maybeSingle();
      return NextResponse.json(
        { error, openSessionId: cur?.current_el_session_id ?? null },
        { status, headers: noStore },
      );
    }
    if (claim.status === "reconnect_limit") {
      // Two causes: the 5 s spacing (wait and retry) or the meeting's mint cap (no retry can
      // succeed: start a new meeting). Tell the page which.
      const { data: rows } = await supabaseAdmin()
        .from("el_sessions")
        .select("kind, started_at")
        .eq("meeting_id", meeting.id)
        .in("kind", ["live", "unminted"]);
      const live = (rows ?? []).filter((r) => r.kind === "live").length;
      if (live >= MAX_MINTS_PER_MEETING) return fail("mint_cap", 429);
      // The spacing grows with the mints (0022): tell the page how long to wait.
      const last = Math.max(0, ...(rows ?? []).map((r) => Date.parse(r.started_at as string)));
      const retryAfter = Math.max(1, Math.ceil(mintSpacingSeconds(live) - (Date.now() - last) / 1000));
      return NextResponse.json({ error: "reconnect_limit", retryAfter }, { status: 429, headers: noStore });
    }
    return fail(error, status);
  }
  const maxSeconds = claim.maxSeconds!;

  // Dev/test fake ElevenLabs (ignored in production): book the session as 'test', so it never
  // reserves or books ElevenLabs hours or dollars against the caps (0011).
  if (devWsOverride()) {
    const { error: ke } = await supabaseAdmin().from("el_sessions").update({ kind: "test" }).eq("id", sessionId);
    if (ke) console.error(`token: dev session kind: ${ke.message}`);
  }

  let token: string;
  try {
    token = await mintToken(maxSeconds);
  } catch (e) {
    console.error(`token: mint failed for meeting ${meeting.id}: ${(e as Error).message}`);
    await releaseUnmintedElSession(sessionId).catch((ce: Error) =>
      console.error(`token: could not release unminted session ${sessionId}: ${ce.message}`),
    );
    return fail("mint_failed", 502);
  }

  if (closingSessionId) {
    await logEvent(meeting.id, "reconnect", { closed: closingSessionId, sessionId }).catch((le: Error) =>
      console.error(`token: logEvent: ${le.message}`),
    );
  }

  return NextResponse.json({ token, wsUrl: realtimeWsUrl(), sessionId }, { headers: noStore });
}
