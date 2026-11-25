import { NextResponse, type NextRequest } from "next/server";
import { dayUsd } from "@/lib/db/usage";
import { isUuid } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { ensurePerson } from "@/lib/names/people";
import { validName } from "@/lib/names/validate";
import { runNameRound } from "@/lib/names/round";
import { loadSpeakerView, type SpeakerRow } from "@/lib/names/speakers";
import { resolveSpeaker } from "@/lib/segments/resolve";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// POST runs the name round (one short Claude call) inline.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

interface MeetingRef {
  id: string;
  org_id: string;
  started_by: string | null;
  status: string;
  current_el_session_id: string | null;
}

/** The meeting, if the signed-in user started it; else the error response. */
async function starterMeeting(id: string): Promise<MeetingRef | Response> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);
  // As the user: RLS hides meetings of other orgs.
  const { data, error } = await supabase
    .from("meetings")
    .select("id, org_id, started_by, status, current_el_session_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`speakers: meeting: ${error.message}`);
  if (!data) return fail("not_found", 404);
  if (data.started_by !== user.id) return fail("not_starter", 403);
  return data as MeetingRef;
}

/** The speaker list: labels heard, their names, the org's people. Starter only. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const meeting = await starterMeeting((await params).id);
  if (meeting instanceof Response) return meeting;
  return NextResponse.json(await loadSpeakerView(meeting), { headers: noStore });
}

/**
 * "Klar": run the name round now for the current session (also after the automatic one; it
 * only fills labels nobody has named). Starter only, live meetings. Never fails on Claude:
 * `result` is ok | failed | busy | skipped (kill switch or daily cap), plus the speaker list.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const meeting = await starterMeeting((await params).id);
  if (meeting instanceof Response) return meeting;
  if (meeting.status !== "live") return fail("not_live", 409);
  let result = "skipped";
  const env = getEnv();
  if (meeting.current_el_session_id && !env.KILL_SWITCH && (await dayUsd()) < env.GLOBAL_DAILY_USD) {
    result = (await runNameRound(meeting, meeting.current_el_session_id, { force: true })).status;
  }
  return NextResponse.json({ result, ...(await loadSpeakerView(meeting)) }, { headers: noStore });
}

/**
 * Name a speaker. Body `{ elSessionId, speakerLabel, personId?, displayName }`. Starter only.
 * The label must have been heard in that session; it is resolved through merge aliases first;
 * the name is confirmed (needs_confirm off). With personId the person's own name is used.
 * Without it the name must look like a name (validName) and is matched to the org's people
 * (any case) or added to them (the starter confirmed it).
 * Applies to transcript lines written afterwards and to the notes from the next tick.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const meeting = await starterMeeting((await params).id);
  if (meeting instanceof Response) return meeting;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const elSessionId = str(body?.elSessionId, 200);
  const speakerLabel = str(body?.speakerLabel, 100);
  const typedName = validName(body?.displayName);
  const personIdIn = body?.personId ?? null;
  if (!elSessionId || !speakerLabel) return fail("bad_request", 400);
  if (!personIdIn && !typedName) return fail("bad_name", 400);
  if (personIdIn !== null && (typeof personIdIn !== "string" || !isUuid(personIdIn))) return fail("bad_request", 400);

  const db = supabaseAdmin();
  const { data: session, error: se } = await db
    .from("el_sessions")
    .select("id, kind")
    .eq("id", elSessionId)
    .eq("meeting_id", meeting.id)
    .maybeSingle();
  if (se) throw new Error(`speakers: session: ${se.message}`);
  if (!session) return fail("session_not_in_meeting", 400);
  const { data: heard, error: he } = await db
    .from("segments")
    .select("segment_index")
    .eq("el_session_id", elSessionId)
    .eq("speaker", speakerLabel)
    .limit(1);
  if (he) throw new Error(`speakers: heard: ${he.message}`);
  if (!heard?.length) return fail("unknown_speaker", 400);

  let personId: string | null = null;
  let displayName = typedName ?? "";
  if (personIdIn) {
    const { data: person, error } = await db
      .from("people")
      .select("id, name")
      .eq("id", personIdIn)
      .eq("org_id", meeting.org_id)
      .maybeSingle();
    if (error) throw new Error(`speakers: person: ${error.message}`);
    if (!person) return fail("unknown_person", 400);
    personId = person.id as string;
    displayName = person.name as string;
  } else if (session.kind !== "test") {
    const person = await ensurePerson(meeting.org_id, displayName);
    personId = person.id;
    displayName = person.name;
  }

  const { data: rows, error: re } = await db
    .from("speaker_map")
    .select("el_session_id, speaker_label, display_name, person_id, merged_into_label")
    .eq("meeting_id", meeting.id)
    .eq("el_session_id", elSessionId);
  if (re) throw new Error(`speakers: map: ${re.message}`);
  const target = resolveSpeaker((rows ?? []) as SpeakerRow[], speakerLabel).label;
  // Ruling 38: a Testmöte's voices are fictional: name them in the map only, never as people.
  if (session.kind === "test") personId = null;
  const { error: ue } = await db.from("speaker_map").upsert(
    {
      meeting_id: meeting.id,
      el_session_id: elSessionId,
      speaker_label: target,
      display_name: displayName,
      person_id: personId,
      needs_confirm: false,
    },
    { onConflict: "meeting_id,el_session_id,speaker_label" },
  );
  if (ue) throw new Error(`speakers: save: ${ue.message}`);
  return NextResponse.json(await loadSpeakerView(meeting), { headers: noStore });
}
