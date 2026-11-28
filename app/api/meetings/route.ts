import { NextResponse, type NextRequest } from "next/server";
import { apiT, localizeMessage, requestLocale } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { startMeeting, type StartOptions } from "@/lib/meetings/start";
import { EVENT_ID } from "@/lib/calendar/load";

export const dynamic = "force-dynamic";
// Creating the Doc takes a handful of Google calls; an agenda start adds the roles call (at most
// 15 s, then the fuzzy roles) and 10–20 Google calls with conflict retries.
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

const DOC_ID = /^[A-Za-z0-9_-]{10,200}$/;
const KINDS = ["veckomote", "styrelseprotokoll", "arsmote", "enkel"] as const;

/** The optional start options of the body; null when one is present but malformed. */
function startOptions(body: Record<string, unknown>): StartOptions | null {
  // null is the same as absent.
  const opt = (k: string) => (body[k] === null ? undefined : body[k]);
  const [agendaDocId, formatProfileId, formatKind, transcriptInDoc] = ["agendaDocId", "formatProfileId", "formatKind", "transcriptInDoc"].map(opt);
  if (agendaDocId !== undefined && (typeof agendaDocId !== "string" || !DOC_ID.test(agendaDocId))) return null;
  if (formatProfileId !== undefined && (typeof formatProfileId !== "string" || !isUuid(formatProfileId))) return null;
  if (formatKind !== undefined && !KINDS.includes(formatKind as (typeof KINDS)[number])) return null;
  if (transcriptInDoc !== undefined && typeof transcriptInDoc !== "boolean") return null;
  const goalIds = opt("goalIds");
  if (goalIds !== undefined && (!Array.isArray(goalIds) || goalIds.length > 2 || !goalIds.every((g) => typeof g === "string" && isUuid(g)))) return null;
  // "Starta" on a calendar event (todo #14): only its id; the server reads the event itself.
  const calendarEventId = opt("calendarEventId");
  if (calendarEventId !== undefined && (typeof calendarEventId !== "string" || !EVENT_ID.test(calendarEventId))) return null;
  // Privat (0045): the context (checked against the space in startMeeting) and the optional Doc.
  const [contextId, withDoc] = ["contextId", "withDoc"].map(opt);
  if (contextId !== undefined && (typeof contextId !== "string" || !isUuid(contextId))) return null;
  if (withDoc !== undefined && typeof withDoc !== "boolean") return null;
  // Företag (0050): the group (null = Hela företaget; checked against the company in startMeeting) and Privat möte.
  const groupId = body.groupId;
  if (groupId !== undefined && groupId !== null && (typeof groupId !== "string" || !isUuid(groupId))) return null;
  const priv = opt("private");
  if (priv !== undefined && typeof priv !== "boolean") return null;
  // Företag: the colleagues the starter confirmed as attending (checked against the event's guests).
  // A video call (0058): the call tab + mic, consented to as such. Absent: the room.
  const captureSource = opt("captureSource");
  if (captureSource !== undefined && captureSource !== "room" && captureSource !== "call") return null;
  // The growth loop (0067): the starter's "Gäster utan konto får en sammanfattning från dig" toggle.
  const inviteAttendees = opt("inviteAttendees");
  if (inviteAttendees !== undefined && typeof inviteAttendees !== "boolean") return null;
  const attendeeIds = opt("attendeeIds");
  if (attendeeIds !== undefined && (!Array.isArray(attendeeIds) || attendeeIds.length > 100 || !attendeeIds.every((a) => typeof a === "string" && isUuid(a)))) return null;
  return {
    ...(captureSource === "call" ? { captureSource: "call" as const } : {}),
    ...(inviteAttendees === false ? { inviteAttendees: false } : {}),
    ...(attendeeIds !== undefined ? { attendeeIds: attendeeIds as string[] } : {}),
    ...(groupId !== undefined ? { groupId: groupId as string | null } : {}),
    ...(priv !== undefined ? { private: priv as boolean } : {}),
    ...(calendarEventId !== undefined ? { calendarEventId: calendarEventId as string } : {}),
    ...(contextId !== undefined ? { contextId: contextId as string } : {}),
    ...(withDoc !== undefined ? { withDoc: withDoc as boolean } : {}),
    ...(goalIds !== undefined ? { goalIds: goalIds as string[] } : {}),
    agendaDocId: agendaDocId as string | undefined,
    formatProfileId: formatProfileId as string | undefined,
    formatKind: formatKind as StartOptions["formatKind"],
    transcriptInDoc: transcriptInDoc as boolean | undefined,
  };
}

/**
 * Start a meeting. Body: `{ "orgId": string, "consent": true, "agendaDocId"?: string,
 * "formatProfileId"?: uuid, "formatKind"?: "veckomote"|"styrelseprotokoll"|"enkel",
 * "transcriptInDoc"?: boolean, "goalIds"?: uuid[], "contextId"?: uuid, "withDoc"?: boolean,
 * "calendarEventId"?: string, "groupId"?: uuid|null, "private"?: boolean }` (groupId and private: a Företag, 0050, or a förening with groups, 0054; calendarEventId: "Starta" on a calendar event, todo #14; contextId and
 * withDoc: a Privat space only, 0045; goalIds: at most two goals ticked under "Mål att
 * ta upp", added as topic items to a new Doc in a format; todo #12) (consent: everyone in the room knows the meeting is
 * transcribed). With `agendaDocId` the meeting runs in the förening's own agenda Doc; without it
 * a new Doc in the chosen format (Enkel: today's Doc) is created in the caller's Drive and shared
 * with the org's other members. Returns `{ meetingId, docUrl, title, shareFailed, agenda,
 * appended, carried }`. Only members; 409 if the org already has a live meeting. Nothing is
 * written to the database (or the agenda Doc) when a check fails.
 */
export async function POST(request: NextRequest) {
  const t = apiT(request);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!isUuid(orgId)) return fail("bad_request", 400, t("api.orgMissing"));
  if (body?.consent !== true) {
    return fail("no_consent", 400, t("api.noConsent"));
  }
  const opts = startOptions(body!);
  if (!opts) return fail("bad_request", 400, t("api.badStart"));
  if (getEnv().KILL_SWITCH) {
    return fail("kill_switch", 503, t("api.killSwitch"));
  }

  const result = await startMeeting(supabase, user, orgId, "started", opts);
  if (!result.ok) return fail(result.error, result.status, localizeMessage(result.message, requestLocale(request)));

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
