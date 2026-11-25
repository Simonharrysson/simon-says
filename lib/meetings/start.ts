import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMeetingDoc, meetingTitle, type MeetingDoc } from "@/lib/docs/create";
import { logEvent } from "@/lib/db/events";
import { memberEmails } from "@/lib/db/members";
import { getOrg, myRole } from "@/lib/db/orgs";
import type { MeetingEventKind } from "@/lib/db/types";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { MAX_STARTS_PER_HOUR } from "@/lib/limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";

export type StartResult =
  | { ok: true; meetingId: string; docUrl: string; orgName: string; title: string; shareFailed: number }
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

  const limited = await startLimit(user.id);
  if (limited) return limited;

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

  // Re-check after the insert, atomically (0021): of concurrent starts exactly one survives; the
  // guard deletes a losing row itself (its Doc stays in Drive).
  const { data: guard, error: guardError } = await supabaseAdmin().rpc("guard_meeting_start", {
    p_meeting_id: meetingId,
    p_max_per_hour: MAX_STARTS_PER_HOUR,
  });
  if (guardError) throw new Error(`meetings: start guard: ${guardError.message}`);
  if (guard === "starter_busy") return startBusy();
  if (guard === "start_rate") return startRate();

  await logEvent(meetingId, eventKind, {
    by: user.id,
    shareFailed: doc.shareFailed.length,
    transcriptTab: doc.transcriptTabId !== null,
  }).catch((e: Error) => console.error(`meetings: logEvent: ${e.message}`));


  return {
    ok: true,
    meetingId,
    docUrl: docUrl(doc.docId),
    orgName: org.name,
    title: meetingTitle(org.name, startedAt),
    shareFailed: doc.shareFailed.length,
  };
}

const startBusy = () =>
  failed("starter_busy", 409, "Du har redan ett möte igång. Öppna det och avsluta det först (under Möten i föreningen).");
const startRate = () =>
  failed("start_rate", 429, "Du har startat många möten den senaste timmen. Vänta en stund och försök igen.");

/**
 * Per-user start limits (Ruling 39), counted from meetings rows across every org: at most one
 * live meeting per starter, and MAX_STARTS_PER_HOUR starts per rolling hour. Checked before the
 * Doc is created; guard_meeting_start (0021) enforces the same atomically after the insert.
 */
async function startLimit(userId: string): Promise<StartResult | null> {
  const db = supabaseAdmin();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const [active, recent] = await Promise.all([
    db.from("meetings").select("id, started_at").eq("started_by", userId).eq("status", "live"),
    db.from("meetings").select("id, started_at").eq("started_by", userId).gte("started_at", hourAgo),
  ]);
  if (active.error) throw new Error(`meetings: start limit: ${active.error.message}`);
  if (recent.error) throw new Error(`meetings: start limit: ${recent.error.message}`);
  if ((active.data ?? []).length > 0) return startBusy();
  if ((recent.data ?? []).length >= MAX_STARTS_PER_HOUR) return startRate();
  return null;
}
