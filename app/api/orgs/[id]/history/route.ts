import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/** Removes every imported protocol of the förening (admins only, 0032 clear_history_protocols). */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan ta bort inlästa protokoll.");
  const { data, error } = await db.rpc("clear_history_protocols", { p_org_id: id });
  if (error) {
    if (error.code === "42501") return fail("forbidden", 403, "Bara administratörer kan ta bort inlästa protokoll.");
    console.error(`history: clear: ${error.message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }
  return NextResponse.json({ ok: true, removed: data ?? 0 }, { headers: noStore });
}
