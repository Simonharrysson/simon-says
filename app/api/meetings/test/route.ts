import { after, NextResponse, type NextRequest } from "next/server";
import type { OAuth2Client } from "google-auth-library";
import { isUuid } from "@/lib/db/ids";
import { getOrg } from "@/lib/db/orgs";
import { getEnv } from "@/lib/env";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { endMeeting } from "@/lib/meetings/tick";
import { startMeeting, type StartResult } from "@/lib/meetings/start";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canRunTestMeeting } from "@/lib/testmeeting/admin";
import { createTestAgendaDoc, testRun, trashTestDoc } from "@/lib/testmeeting/agenda";
import { runFeed, seedTestSession } from "@/lib/testmeeting/feed";
import { AGENDA_FIXTURE_LINES, type FixtureLine } from "@/lib/testmeeting/fixture";

export const dynamic = "force-dynamic";
// The replay (≈ 150 s at 4×) and the final pass run after the response, in after().
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Testmöte. Body: `{ "orgId": string, "mode"?: "new" | "agenda" }`. Admins only (ADMIN_EMAILS, else ALARM_EMAIL), members
 * of the org. Starts a real meeting exactly like "Starta möte" (consent given by the admin,
 * event `test_started`), seeds a test ElevenLabs session (names come from the name round), answers, and
 * then replays a fictional 10-minute meeting at 4× through the real ingest, ticks and end.
 * 409 if the org already has a live meeting; 503 under the kill switch.
 *
 * `mode: "agenda"` ("Testmöte med dagordning", A13): first a fictional Veckomöte agenda Doc
 * (createTestAgendaDoc), then the test meeting starts in that Doc in agenda mode (Veckomöte, no
 * transcript tab) and replays run A of the fictional club, or run B once the org has a finished
 * agenda Testmöte (its open tasks are carried into "Från förra veckan"). A refused start trashes
 * the new Doc.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!canRunTestMeeting(user.email)) return fail("forbidden", 403, "Testmöte är bara för administratörer.");

  const body = (await request.json().catch(() => null)) as { orgId?: unknown; mode?: unknown } | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!isUuid(orgId)) return fail("bad_request", 400, "Föreningen saknas. Ladda om sidan och försök igen.");
  const mode = body?.mode ?? "new";
  if (mode !== "new" && mode !== "agenda") return fail("bad_request", 400, "Okänt testläge. Ladda om sidan och försök igen.");
  if (getEnv().KILL_SWITCH) return fail("kill_switch", 503, "Tjänsten är pausad just nu. Försök igen senare.");

  let result: StartResult;
  let lines: FixtureLine[] | undefined;
  if (mode === "agenda") {
    const started = await startAgendaTest(supabase, user, orgId);
    if ("response" in started) return started.response;
    ({ result, lines } = started);
  } else {
    result = await startMeeting(supabase, user, orgId, "test_started");
  }
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

  const meetingId = result.meetingId;
  after(() => (lines ? runFeed(meetingId, sessionId, startedAt, undefined, lines) : runFeed(meetingId, sessionId, startedAt)));
  return NextResponse.json({ meetingId, docUrl: result.docUrl }, { headers: noStore });
}

/** Agenda mode: the fictional agenda Doc, then the start in it; the run's lines. */
async function startAgendaTest(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  user: { id: string; email?: string | null },
  orgId: string,
): Promise<{ result: StartResult; lines: FixtureLine[] } | { response: NextResponse }> {
  // As the user: RLS hides orgs they are not in. startMeeting checks membership again.
  const org = await getOrg(supabase, orgId);
  if (!org) return { response: fail("not_found", 404, "Föreningen finns inte.") };
  let auth: OAuth2Client;
  try {
    auth = await getGoogleAuth(user.id);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return { response: fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.") };
    }
    console.error(`test meeting: google auth: ${(err as Error).message}`);
    return { response: fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.") };
  }
  let run: "a" | "b";
  let docId: string;
  try {
    // Before the new meeting exists: only finished agenda Testmöten count.
    run = await testRun(orgId);
    ({ docId } = await createTestAgendaDoc(auth, { orgName: org.name, folderId: org.meeting_folder_id ?? null, startedAt: new Date() }));
  } catch (err) {
    console.error(`test meeting: agenda doc: ${(err as Error).message}`);
    return { response: fail("doc_failed", 502, "Vi kunde inte skapa testdokumentet i din Google Drive. Försök igen om en liten stund.") };
  }
  const result = await startMeeting(supabase, user, orgId, "test_started", {
    agendaDocId: docId,
    // The standard row is ensured inside startMeeting, after its start guard.
    formatKind: "veckomote",
    transcriptInDoc: false,
    isTest: true,
  });
  if (!result.ok) {
    await trashTestDoc(auth, docId).catch((e: Error) => console.error(`test meeting: trash unused agenda doc: ${e.message}`));
  }
  return { result, lines: AGENDA_FIXTURE_LINES[run] };
}
