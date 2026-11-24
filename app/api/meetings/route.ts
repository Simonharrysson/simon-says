import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createMeetingDoc, type MeetingDoc } from "@/lib/docs/create";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { memberEmails } from "@/lib/db/members";
import { getOrg, myRole } from "@/lib/db/orgs";
import { getEnv } from "@/lib/env";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";

export const dynamic = "force-dynamic";
// Creating the Doc takes a handful of Google calls.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Start a meeting. Body: `{ "orgId": string, "consent": true }` (consent: everyone in the room
 * knows the meeting is transcribed). Creates the Google Doc in the caller's Drive, shares it
 * with the org's other members and writes the meetings row. Returns `{ meetingId, docUrl }`.
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

  // As the user: RLS hides other people's orgs (404).
  const org = await getOrg(supabase, orgId);
  if (!org) return fail("not_found", 404, "Föreningen finns inte.");
  if ((await myRole(supabase, orgId)) === null) {
    return fail("not_member", 403, "Du är inte medlem i föreningen.");
  }

  const { data: active, error: activeError } = await supabase
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["live", "ending"])
    .limit(1);
  if (activeError) throw new Error(`meetings: active check: ${activeError.message}`);
  if ((active ?? []).length > 0) {
    return fail("already_live", 409, "Ett möte pågår redan i föreningen. Avsluta det först.");
  }

  let auth;
  try {
    auth = await getGoogleAuth(user.id);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail(
        "google_auth_lost",
        401,
        "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen, så kan du starta mötet.",
      );
    }
    console.error(`meetings: google auth: ${(err as Error).message}`);
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }

  const meetingId = randomUUID();
  const startedAt = new Date();
  let doc: MeetingDoc;
  try {
    const others = (await memberEmails(orgId)).filter((e) => e.toLowerCase() !== (user.email ?? "").toLowerCase());
    doc = await createMeetingDoc(auth, {
      meetingId,
      orgName: org.name,
      startedAt,
      memberEmails: others,
      shareTranscript: org.share_transcript,
    });
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    console.error(`meetings: create doc failed: ${(err as Error).message}`);
    return fail("doc_failed", 502, "Vi kunde inte skapa mötesdokumentet i din Google Drive. Försök igen om en liten stund.");
  }

  const { error: insertError } = await supabaseAdmin()
    .from("meetings")
    .insert({
      id: meetingId,
      org_id: orgId,
      started_by: user.id,
      doc_id: doc.docId,
      notes_tab_id: doc.notesTabId,
      transcript_tab_id: doc.transcriptTabId,
      header_range: doc.headerRange,
      header_rendered: doc.headerRendered,
      section_ranges: doc.sectionRanges,
      status: "live",
      consent_confirmed_at: startedAt.toISOString(),
      started_at: startedAt.toISOString(),
    });
  if (insertError) {
    console.error(`meetings: insert failed (Doc ${doc.docId} left in Drive): ${insertError.message}`);
    return fail("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
  }

  await logEvent(meetingId, "started", {
    by: user.id,
    shareFailed: doc.shareFailed.length,
    transcriptTab: doc.transcriptTabId !== null,
  }).catch((e: Error) => console.error(`meetings: logEvent: ${e.message}`));

  return NextResponse.json({ meetingId, docUrl: docUrl(doc.docId) }, { headers: noStore });
}
