import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { startMeeting, type StartOptions } from "@/lib/meetings/start";

export const dynamic = "force-dynamic";
// Creating the Doc takes a handful of Google calls; an agenda start adds the roles call (at most
// 15 s, then the fuzzy roles) and 10–20 Google calls with conflict retries.
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

const DOC_ID = /^[A-Za-z0-9_-]{10,200}$/;
const KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

/** The optional start options of the body; null when one is present but malformed. */
function startOptions(body: Record<string, unknown>): StartOptions | null {
  // null is the same as absent.
  const opt = (k: string) => (body[k] === null ? undefined : body[k]);
  const [agendaDocId, formatProfileId, formatKind, transcriptInDoc] = ["agendaDocId", "formatProfileId", "formatKind", "transcriptInDoc"].map(opt);
  if (agendaDocId !== undefined && (typeof agendaDocId !== "string" || !DOC_ID.test(agendaDocId))) return null;
  if (formatProfileId !== undefined && (typeof formatProfileId !== "string" || !isUuid(formatProfileId))) return null;
  if (formatKind !== undefined && !KINDS.includes(formatKind as (typeof KINDS)[number])) return null;
  if (transcriptInDoc !== undefined && typeof transcriptInDoc !== "boolean") return null;
  return {
    agendaDocId: agendaDocId as string | undefined,
    formatProfileId: formatProfileId as string | undefined,
    formatKind: formatKind as StartOptions["formatKind"],
    transcriptInDoc: transcriptInDoc as boolean | undefined,
  };
}

/**
 * Start a meeting. Body: `{ "orgId": string, "consent": true, "agendaDocId"?: string,
 * "formatProfileId"?: uuid, "formatKind"?: "veckomote"|"styrelseprotokoll"|"enkel",
 * "transcriptInDoc"?: boolean }` (consent: everyone in the room knows the meeting is
 * transcribed). With `agendaDocId` the meeting runs in the förening's own agenda Doc; without it
 * a new Doc in the chosen format (Enkel: today's Doc) is created in the caller's Drive and shared
 * with the org's other members. Returns `{ meetingId, docUrl, title, shareFailed, agenda,
 * appended, carried }`. Only members; 409 if the org already has a live meeting. Nothing is
 * written to the database (or the agenda Doc) when a check fails.
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!isUuid(orgId)) return fail("bad_request", 400, "Föreningen saknas. Ladda om sidan och försök igen.");
  if (body?.consent !== true) {
    return fail("no_consent", 400, "Bekräfta att alla i rummet vet att mötet transkriberas.");
  }
  const opts = startOptions(body!);
  if (!opts) return fail("bad_request", 400, "Startuppgifterna är ogiltiga. Ladda om sidan och försök igen.");
  if (getEnv().KILL_SWITCH) {
    return fail("kill_switch", 503, "Tjänsten är pausad just nu. Försök igen senare.");
  }

  const result = await startMeeting(supabase, user, orgId, "started", opts);
  if (!result.ok) return fail(result.error, result.status, result.message);

  return NextResponse.json(
    // shareFailed: members the Doc could not be shared with (the page asks to share manually).
    {
      meetingId: result.meetingId,
      docUrl: result.docUrl,
      title: result.title,
      shareFailed: result.shareFailed,
      // meeting_folder | own_folder | agenda: the page says when the Doc missed the förening's folder.
      docPlace: result.docPlace,
      missedMeetingFolder: result.missedMeetingFolder,
      agenda: result.agenda,
      appended: result.appended,
      carried: result.carried,
      // Required items (stadgar) the agenda Doc lacks: the page says so, nothing is added to the Doc.
      warnings: result.warnings,
    },
    { headers: noStore },
  );
}
