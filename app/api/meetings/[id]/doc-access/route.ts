import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { appCreatedDoc, claimAccessRequest, shareMeetingDocWith } from "@/lib/docs/access";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

const ASK = "Vi kunde inte dela dokumentet med dig. Be den som startade mötet dela det.";

/**
 * "Få åtkomst" on the förening page: a member asks for a meeting Doc they haven't got (they joined
 * later, or the share at the start failed). The Doc is shared with the caller's own sign-in
 * address through the starter's Google grant (the owner) and recorded. Only Docs Simon Says
 * created; at most ACCESS_REQUESTS_PER_HOUR presses per member and meeting (429). 204 on success;
 * 409 with a Swedish message when the caller must ask the starter (not our Doc, starter left,
 * Google connection lapsed, or Google refused).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Mötet finns inte.");
  if (!user.email) return fail("no_email", 409, ASK);

  // As the user: RLS shows meetings of the caller's own föreningar only (404 otherwise).
  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, org_id, doc_id, started_by, agenda_doc, app_created_doc")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    // A database without 0030: nothing can be recorded, so ask the starter.
    if (error.code === "42703" || error.code === "PGRST204") return fail("not_ready", 409, ASK);
    throw new Error(`doc-access: meeting: ${error.message}`);
  }
  if (!meeting || !meeting.doc_id) return fail("not_found", 404, "Mötet finns inte.");
  // The förening's own agenda Doc: theirs to share, no Drive call.
  if (!appCreatedDoc(meeting) && meeting.started_by !== user.id) return fail("not_ours", 409, ASK);
  if (!(await claimAccessRequest(meeting.id, user.id))) {
    return fail("rate_limited", 429, "Du har redan bett om åtkomst flera gånger. Be den som startade mötet dela dokumentet.");
  }

  const outcome = await shareMeetingDocWith(meeting, { id: user.id, email: user.email });
  if (outcome === "shared") return new NextResponse(null, { status: 204, headers: noStore });
  return fail(outcome, 409, ASK);
}
