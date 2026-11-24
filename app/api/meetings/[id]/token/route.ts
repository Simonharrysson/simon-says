import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { claimElSession, closeElSession, type ClaimStatus } from "@/lib/db/usage";
import { mintToken, realtimeWsUrl } from "@/lib/elevenlabs/token";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Refusals from claim_el_session → [HTTP status, error]. 429 `reconnect_limit`: retry after
// 5 s unless the meeting has used its 30 mints.
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
 * at most one mint per 5 s and 30 per meeting, and only while every cap has time left. The
 * whole decision (lock, rate limit, caps, max duration) is made atomically in
 * claim_el_session. The session's max duration is the time left (≤ 4 h), so one session
 * normally covers the whole meeting. Usage is booked from server times when the session is
 * closed (on the next mint, or by the end/cleanup jobs).
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
  // mint. A failed mint closes the claimed session again (≈ 0 s booked) so a retry is allowed
  // (after the 5 s mint spacing).
  const sessionId = randomUUID();
  const claim = await claimElSession(meeting.id, sessionId, closingSessionId);
  if (claim.status !== "ok") {
    const [status, error] = refusal[claim.status];
    return fail(error, status);
  }
  const maxSeconds = claim.maxSeconds!;

  let token: string;
  try {
    token = await mintToken(maxSeconds);
  } catch (e) {
    console.error(`token: mint failed for meeting ${meeting.id}: ${(e as Error).message}`);
    await closeElSession(sessionId).catch((ce: Error) =>
      console.error(`token: could not close unminted session ${sessionId}: ${ce.message}`),
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
