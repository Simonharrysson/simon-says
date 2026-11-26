import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { extractRequiredItems } from "@/lib/formats/stadgar";
import { readStadgarFile } from "@/lib/formats/stadgar-file";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Required agenda items from the förening's stadgar (Task C1). Body `{ fileId }`: a Google Doc
 * (read as plain text) or a PDF (at most 10 MB), picked by an admin and read with the admin's own
 * Google grant. → `{ requiredItems }`. Stores nothing; the stadgar text is never logged.
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
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan byta mötesformat.");

  const body = (await request.json().catch(() => null)) as { fileId?: unknown } | null;
  const fileId = typeof body?.fileId === "string" ? body.fileId : "";
  if (!DRIVE_ID.test(fileId)) return fail("bad_request", 400, "Välj stadgarna i Google-väljaren igen.");

  const file = await readStadgarFile(user.id, fileId, "formats/stadgar");
  if (!file.ok) return fail(file.error, file.status, file.message);
  const input = file.input;

  const res = await extractRequiredItems(input, { orgId: id });
  if (!res.ok) {
    if (res.error === "spend") {
      return fail("spend", 503, "Simon Says kan inte läsa stadgarna just nu. Försök igen i morgon.");
    }
    return fail(res.error, 502, "Simon Says kunde inte läsa stadgarna. Försök igen.");
  }
  console.info(`formats/stadgar: ${input.kind}, ${res.items.length} items`);
  return NextResponse.json({ requiredItems: res.items }, { headers: noStore });
}
