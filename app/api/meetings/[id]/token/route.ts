import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { beginElSession, closeElSession } from "@/lib/db/usage";
import { mintToken, realtimeWsUrl } from "@/lib/elevenlabs/token";
import { checkLimits, type LimitReason } from "@/lib/limits";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const limitStatus: Record<LimitReason, number> = {
  kill_switch: 503,
  no_consent: 403,
  global_usd: 429,
  global_day: 429,
  org_month: 429,
  meeting_length: 429,
};

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Mint an ElevenLabs single-use token for the meeting's next transcription session.
 * Body: `{ "closingSessionId"?: string }` — the session whose socket just closed (reconnect).
 * Returns `{ token, wsUrl, sessionId }`; connect to `${wsUrl}&token=${token}`.
 *
 * Only the member who started the meeting, only while it is live and consent is confirmed,
 * and only while every cap has time left. The session's max duration is the time left
 * (≤ 4 h), so one session normally covers the whole meeting. Usage is booked from server
 * times when the session is closed (on the next mint, or by the end/cleanup jobs).
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
    .select("id, org_id, started_by, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`token: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);

  const body = (await request.json().catch(() => null)) as { closingSessionId?: unknown } | null;
  const closing = body?.closingSessionId;
  if (closing !== undefined && closing !== null && (typeof closing !== "string" || closing.length > 200)) {
    return fail("bad_request", 400);
  }
  const closingSessionId = typeof closing === "string" ? closing : null;

  const limits = await checkLimits(meeting.org_id, meeting.id);
  if (limits.stop) return fail(limits.reason!, limitStatus[limits.reason!]);
  if (meeting.status !== "live") return fail("not_live", 409);

  // Claim the session first (atomic lock + closing the previous one), then mint. A failed
  // mint closes the claimed session again (≈ 0 s booked) so a retry is allowed.
  const sessionId = randomUUID();
  const maxSeconds = limits.remainingSeconds;
  const claim = await beginElSession(meeting.id, sessionId, maxSeconds, closingSessionId);
  if (claim === "busy") return fail("session_open", 409);
  if (claim === "not_live") return fail("not_live", 409);
  if (claim === "not_found") return fail("not_found", 404);

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
