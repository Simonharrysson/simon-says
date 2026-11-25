import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { startMeeting } from "@/lib/meetings/start";

export const dynamic = "force-dynamic";
// Creating the Doc takes a handful of Google calls.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Start a meeting. Body: `{ "orgId": string, "consent": true }` (consent: everyone in the room
 * knows the meeting is transcribed). Creates the Google Doc in the caller's Drive, shares it
 * with the org's other members and writes the meetings row. Returns `{ meetingId, docUrl, title }`.
 * Only members; 409 if the org already has a live meeting. Nothing is left behind in the
 * database if the Doc cannot be created.
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");

  const body = (await request.json().catch(() => null)) as { orgId?: unknown; consent?: unknown } | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!isUuid(orgId)) return fail("bad_request", 400, "Föreningen saknas. Ladda om sidan och försök igen.");
  if (body?.consent !== true) {
    return fail("no_consent", 400, "Bekräfta att alla i rummet vet att mötet transkriberas.");
  }
  if (getEnv().KILL_SWITCH) {
    return fail("kill_switch", 503, "Tjänsten är pausad just nu. Försök igen senare.");
  }

  const result = await startMeeting(supabase, user, orgId);
  if (!result.ok) return fail(result.error, result.status, result.message);

  return NextResponse.json(
    // shareFailed: members the Doc could not be shared with (the page asks to share manually).
    { meetingId: result.meetingId, docUrl: result.docUrl, title: result.title, shareFailed: result.shareFailed },
    { headers: noStore },
  );
}
