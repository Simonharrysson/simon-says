import { after, NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { endMeeting } from "@/lib/meetings/tick";
import { startMeeting } from "@/lib/meetings/start";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canRunTestMeeting } from "@/lib/testmeeting/admin";
import { runFeed, seedTestSession } from "@/lib/testmeeting/feed";

export const dynamic = "force-dynamic";
// The replay (≈ 150 s at 4×) and the final pass run after the response, in after().
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Testmöte. Body: `{ "orgId": string }`. Admins only (ADMIN_EMAILS, else ALARM_EMAIL), members
 * of the org. Starts a real meeting exactly like "Starta möte" (consent given by the admin,
 * event `test_started`), seeds a test ElevenLabs session (names come from the name round), answers, and
 * then replays a fictional 10-minute meeting at 4× through the real ingest, ticks and end.
 * 409 if the org already has a live meeting; 503 under the kill switch.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!canRunTestMeeting(user.email)) return fail("forbidden", 403, "Testmöte är bara för administratörer.");

  const body = (await request.json().catch(() => null)) as { orgId?: unknown } | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!isUuid(orgId)) return fail("bad_request", 400, "Föreningen saknas. Ladda om sidan och försök igen.");
  if (getEnv().KILL_SWITCH) return fail("kill_switch", 503, "Tjänsten är pausad just nu. Försök igen senare.");

  const result = await startMeeting(supabase, user, orgId, "test_started");
  if (!result.ok) return fail(result.error, result.status, result.message);

  let sessionId: string;
  try {
    sessionId = await seedTestSession(result.meetingId);
  } catch (err) {
    console.error(`test meeting ${result.meetingId}: ${(err as Error).message}`);
    // Ending runs a final pass: after the response, so the 500 is immediate.
    after(() => endMeeting(result.meetingId, { abandon: true }).catch(() => undefined));
    return fail("save_failed", 500, "Testmötet kunde inte startas. Försök igen om en liten stund.");
  }

  after(() => runFeed(result.meetingId, sessionId, startedAt));
  return NextResponse.json({ meetingId: result.meetingId, docUrl: result.docUrl }, { headers: noStore });
}
