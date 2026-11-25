import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * The förening's meeting folder, picked in the Google Picker. Body `{ folderId, grantOnly? }`.
 * Admin without `grantOnly` (FormatCard): sets `orgs.meeting_folder_id` (204). Everyone else —
 * members, and the start screen's "Använd mötesmappen" (`grantOnly: true`, admins too): 204 only
 * when `folderId` is already the förening's folder (their own pick just granted their token
 * access to it), else 403. The start screen never changes the folder.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");

  const body = (await request.json().catch(() => null)) as { folderId?: unknown; grantOnly?: unknown } | null;
  const folderId = typeof body?.folderId === "string" ? body.folderId : "";
  if (!DRIVE_ID.test(folderId)) return fail("bad_request", 400, "Mappen saknas. Välj den i Google-väljaren igen.");

  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");

  if (role === "admin" && body?.grantOnly !== true) {
    const { data, error } = await db.from("orgs").update({ meeting_folder_id: folderId }).eq("id", id).select("id");
    if (error || (data ?? []).length === 0) {
      if (error) console.error(`meeting-folder: update: ${error.message}`);
      return fail("save_failed", 500, "Mötesmappen kunde inte sparas. Försök igen.");
    }
    return new NextResponse(null, { status: 204, headers: noStore });
  }

  const org = await getOrg(db, id);
  if (org && org.meeting_folder_id && org.meeting_folder_id === folderId) {
    return new NextResponse(null, { status: 204, headers: noStore });
  }
  return fail(
    "not_meeting_folder",
    403,
    "Det är inte föreningens mötesmapp. Välj mappen som administratören har valt, eller be en administratör byta den.",
  );
}
