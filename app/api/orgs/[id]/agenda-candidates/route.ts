import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { checkAgendaDoc } from "@/lib/agenda/access";
import { listCandidates, type DriveDoc } from "@/lib/agenda/candidates";
import { localDate } from "@/lib/docs/create";
import type { PreparedSuggestion } from "@/lib/prepare/types";
export type { PreparedSuggestion };
import { nextPrepared } from "@/lib/prepare/store";
import { preparedDocState } from "@/lib/prepare/stale";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { DriveAccountLostError, driveSubOf, orgDriveClient } from "@/lib/google/drive-account";
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
async function preparedSuggestion(p: NonNullable<Awaited<ReturnType<typeof preparedRow>>>, auth: Auth, userId: string): Promise<PreparedSuggestion | null> {
  try {
    // A Doc the förening's Drive account made (0070) is checked through that account: the start uses it too.
    const sub = await driveSubOf("prepared_agendas", p.id);
    const access = await checkAgendaDoc(sub ? await orgDriveClient(p.org_id, sub) : auth, p.doc_id);
    // Never suggest a Doc that is gone (trashed, or deleted: the preparer no longer sees it).
    const state = preparedDocState(access, p.prepared_by === userId);
    if (state === "gone" || (!access.ok && access.error !== "not_found")) return null;
    return { docId: p.doc_id, name: access.ok ? access.name || p.doc_name : p.doc_name, date: p.meeting_date, time: p.meeting_time, kind: p.kind, accessible: access.ok };
  } catch (err) {
    // The förening's account needs renewing (admins see it at the folder): no suggestion meanwhile.
    if (err instanceof DriveAccountLostError) return null;
    if (err instanceof GoogleAuthLostError) throw err;
    console.error(`agenda-candidates: prepared: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Agenda-Doc candidates in the förening's meeting folder, read with the caller's own Google
 * grant. Docs already used by any meeting of the förening are left out. Members only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));
  if (!isUuid(id)) return fail("not_found", 404, t("api.orgNotFound"));
  const org = await getOrg(db, id);
  if (!org || (await myRole(db, id)) === null) return fail("not_found", 404, t("api.orgNotFound"));

  const folderId = org.meeting_folder_id ?? null;
  const folderName = org.meeting_folder_name ?? null;
  const row = await preparedRow(id);
  if (!folderId && !row) {
    const none: AgendaCandidates = { folderId, folderName, accessible: false, candidates: [], suggestedId: null, prepared: null };
    return NextResponse.json(none, { headers: noStore });
  }
  try {
    const auth = await getGoogleAuth(user.id);
    const prepared = row ? await preparedSuggestion(row, auth, user.id) : null;
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
      return fail("google_auth_lost", 401, t("api.googleAuthLost"));
    }
    // The message only: never file names.
    console.error(`agenda-candidates: drive: ${(err as Error).message}`);
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }
}
