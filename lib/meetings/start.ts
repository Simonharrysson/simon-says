import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMeetingDoc, type MeetingDoc } from "@/lib/docs/create";
import { logEvent } from "@/lib/db/events";
import { memberEmails } from "@/lib/db/members";
import { getOrg, myRole } from "@/lib/db/orgs";
import type { MeetingEventKind } from "@/lib/db/types";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";

export type StartResult =
  | { ok: true; meetingId: string; docUrl: string; orgName: string }
  | { ok: false; error: string; status: number; message: string };

const failed = (error: string, status: number, message: string): StartResult => ({ ok: false, error, status, message });

/**
 * The shared start logic of "Starta möte" and "Testmöte" (consent and the kill switch are
 * checked by the caller). Creates the Doc in the user's Drive, shares it with the org's other
 * members and writes the meetings row; nothing is left in the database if the Doc cannot be
 * created. Logs `eventKind` ('started', or 'test_started' for Testmöte).
 */
export async function startMeeting(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
  orgId: string,
  eventKind: Extract<MeetingEventKind, "started" | "test_started"> = "started",
): Promise<StartResult> {
  // As the user: RLS hides other people's orgs (404).
  const org = await getOrg(supabase, orgId);
  if (!org) return failed("not_found", 404, "Föreningen finns inte.");
  if ((await myRole(supabase, orgId)) === null) {
    return failed("not_member", 403, "Du är inte medlem i föreningen.");
  }

  const { data: active, error: activeError } = await supabase
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["live", "ending"])
    .limit(1);
  if (activeError) throw new Error(`meetings: active check: ${activeError.message}`);
  if ((active ?? []).length > 0) {
    return failed("already_live", 409, "Ett möte pågår redan i föreningen. Avsluta det först.");
  }

  let auth;
  try {
    auth = await getGoogleAuth(user.id);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return failed(
        "google_auth_lost",
        401,
        "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen, så kan du starta mötet.",
      );
    }
    console.error(`meetings: google auth: ${(err as Error).message}`);
    return failed("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
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
      return failed("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    console.error(`meetings: create doc failed: ${(err as Error).message}`);
    return failed("doc_failed", 502, "Vi kunde inte skapa mötesdokumentet i din Google Drive. Försök igen om en liten stund.");
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
    return failed("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
  }

  await logEvent(meetingId, eventKind, {
    by: user.id,
    shareFailed: doc.shareFailed.length,
    transcriptTab: doc.transcriptTabId !== null,
  }).catch((e: Error) => console.error(`meetings: logEvent: ${e.message}`));


  return { ok: true, meetingId, docUrl: docUrl(doc.docId), orgName: org.name };
}
