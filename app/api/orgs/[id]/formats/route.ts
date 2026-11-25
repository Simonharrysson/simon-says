import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { forceLearned } from "@/lib/formats/learn";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });
const FORBIDDEN = "Bara administratörer kan byta mötesformat.";

/**
 * Approve an edited format as the förening's default. Body `{ profile, folderId?, kind? }`:
 * kind "learned" (default, B1/B2) or "styrelseprotokoll" (a Styrelseprotokoll with the stadgar's
 * required items, C1). Admins only.
 * The profile comes back from the browser, so it is forced and validated again (only schema
 * keys are stored). `folderId` becomes the meeting folder only when the förening has none.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");

  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");
  if (role !== "admin") return fail("forbidden", 403, FORBIDDEN);

  const body = (await request.json().catch(() => null)) as { profile?: unknown; folderId?: unknown; kind?: unknown } | null;
  const kindRaw = body?.kind ?? "learned";
  if (kindRaw !== "learned" && kindRaw !== "styrelseprotokoll") return fail("bad_request", 400, "Okänt format.");
  const profile = forceLearned(body?.profile, kindRaw);
  if (!profile) return fail("invalid_profile", 400, "Formatet är inte giltigt. Kontrollera fälten och försök igen.");
  const folderId = body?.folderId ?? null;
  if (folderId !== null && (typeof folderId !== "string" || !DRIVE_ID.test(folderId))) {
    return fail("bad_request", 400, "Mappen är inte giltig.");
  }

  const { data, error } = await db.rpc("set_default_format", { p_org_id: id, p_kind: kindRaw, p_profile: profile });
  if (error) {
    if (error.code === "42501") return fail("forbidden", 403, FORBIDDEN);
    console.error(`formats: set_default_format: ${error.message}`);
    return fail("save_failed", 500, "Formatet kunde inte sparas. Försök igen.");
  }

  if (folderId) {
    const { error: folderError } = await db
      .from("orgs")
      .update({ meeting_folder_id: folderId })
      .eq("id", id)
      .is("meeting_folder_id", null);
    // The format is saved either way; the folder can be set on the card.
    if (folderError) console.error(`formats: meeting folder: ${folderError.message}`);
  }
  return NextResponse.json({ id: data as string }, { headers: noStore });
}
