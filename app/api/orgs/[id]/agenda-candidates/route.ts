import { NextResponse, type NextRequest } from "next/server";
import { listCandidates, type DriveDoc } from "@/lib/agenda/candidates";
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
  const none: AgendaCandidates = { folderId, folderName, accessible: false, candidates: [], suggestedId: null };
  if (!folderId) return NextResponse.json(none, { headers: noStore });

  // Service role: every Doc the förening's meetings have used (other members' meetings too).
  const { data: used, error } = await supabaseAdmin().from("meetings").select("doc_id").eq("org_id", id);
  if (error) throw new Error(`agenda-candidates: used docs: ${error.message}`);
  const usedIds = new Set((used ?? []).map((r) => r.doc_id as string).filter(Boolean));

  try {
    const auth = await getGoogleAuth(user.id);
    const { accessible, candidates } = await listCandidates(auth, folderId, usedIds, new Date());
    const body: AgendaCandidates = { folderId, folderName, accessible, candidates, suggestedId: candidates[0]?.id ?? null };
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
