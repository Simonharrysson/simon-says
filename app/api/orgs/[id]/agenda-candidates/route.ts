import { NextResponse, type NextRequest } from "next/server";
import { checkAgendaDoc } from "@/lib/agenda/access";
import { listCandidates, type DriveDoc } from "@/lib/agenda/candidates";
import { localDate } from "@/lib/docs/create";
import type { MeetingType } from "@/lib/prepare/draft";
import { nextPrepared } from "@/lib/prepare/store";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

export interface AgendaCandidates {
  folderId: string | null;
  /** The folder's name as an admin picked it (0030); null when unknown. The förening's text. */
  folderName: string | null;
  /** The starter's own grant can see the folder (drive.file: they picked it once). */
  accessible: boolean;
  /** Ranked best first; names are the förening's text (UI only, never logged). */
  candidates: DriveDoc[];
  suggestedId: string | null;
  /**
   * Förbered möte: today's (or the nearest upcoming) agenda Simon Says prepared and no meeting
   * has been held in yet, suggested first. `accessible`: this starter's own grant can edit it
   * (drive.file: the preparer's can; another member may need to pick it once in the Picker).
   */
  prepared?: PreparedSuggestion | null;
}

export interface PreparedSuggestion {
  docId: string;
  /** The Doc's file name (the förening's text). */
  name: string;
  date: string;
  time: string | null;
  kind: MeetingType;
  accessible: boolean;
}

type Auth = Awaited<ReturnType<typeof getGoogleAuth>>;

/** Today's (or the nearest upcoming) prepared agenda no meeting was held in (best effort: a failure is none). */
async function preparedRow(orgId: string) {
  try {
    const p = await nextPrepared(orgId, localDate(new Date()));
    if (!p) return null;
    const { data, error } = await supabaseAdmin().from("meetings").select("id").eq("org_id", orgId).eq("doc_id", p.doc_id).eq("status", "done").limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0 ? null : p;
  } catch (err) {
    console.error(`agenda-candidates: prepared: ${(err as Error).message}`);
    return null;
  }
}

/** The suggestion for `p`, with whether this starter's grant can edit it. */
async function preparedSuggestion(p: NonNullable<Awaited<ReturnType<typeof preparedRow>>>, auth: Auth): Promise<PreparedSuggestion | null> {
  try {
    const access = await checkAgendaDoc(auth, p.doc_id);
    if (!access.ok && access.error !== "not_found") return null;
    return { docId: p.doc_id, name: access.ok ? access.name || p.doc_name : p.doc_name, date: p.meeting_date, time: p.meeting_time, kind: p.kind, accessible: access.ok };
  } catch (err) {
    if (err instanceof GoogleAuthLostError) throw err;
    console.error(`agenda-candidates: prepared: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Agenda-Doc candidates in the förening's meeting folder, read with the caller's own Google
 * grant. Docs already used by any meeting of the förening are left out. Members only.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");
  const org = await getOrg(db, id);
  if (!org || (await myRole(db, id)) === null) return fail("not_found", 404, "Föreningen finns inte.");

  const folderId = org.meeting_folder_id ?? null;
  const folderName = org.meeting_folder_name ?? null;
  const row = await preparedRow(id);
  if (!folderId && !row) {
    const none: AgendaCandidates = { folderId, folderName, accessible: false, candidates: [], suggestedId: null, prepared: null };
    return NextResponse.json(none, { headers: noStore });
  }
  try {
    const auth = await getGoogleAuth(user.id);
    const prepared = row ? await preparedSuggestion(row, auth) : null;
    const none: AgendaCandidates = { folderId, folderName, accessible: false, candidates: [], suggestedId: null, prepared };
    if (!folderId) return NextResponse.json(none, { headers: noStore });

    // Service role: every Doc the förening's meetings have used (other members' meetings too).
    const { data: used, error } = await supabaseAdmin().from("meetings").select("doc_id").eq("org_id", id);
    if (error) throw new Error(`agenda-candidates: used docs: ${error.message}`);
    const usedIds = new Set((used ?? []).map((r) => r.doc_id as string).filter(Boolean));

    const { accessible, candidates } = await listCandidates(auth, folderId, usedIds, new Date());
    const body: AgendaCandidates = { folderId, folderName, accessible, candidates, suggestedId: candidates[0]?.id ?? null, prepared };
    return NextResponse.json(body, { headers: noStore });
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    // The message only: never file names.
    console.error(`agenda-candidates: drive: ${(err as Error).message}`);
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
}
