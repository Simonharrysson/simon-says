import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { validDate } from "@/lib/history/extract-prompt";
import { setProtocolDate } from "@/lib/history/store";
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

/**
 * Corrects an imported protocol's date (one that fell back to the Doc's creation date): body
 * `{ protocolId, date }`. Admins only (0032 set_history_protocol_date); not in the future.
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
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan ändra inlästa protokoll.");
  const body = (await request.json().catch(() => null)) as { protocolId?: unknown; date?: unknown } | null;
  const protocolId = body?.protocolId;
  const date = typeof body?.date === "string" ? validDate(body.date) : null;
  if (typeof protocolId !== "string" || !isUuid(protocolId) || !date) return fail("bad_request", 400, "Ange ett datum som inte ligger i framtiden.");
  const res = await setProtocolDate(db, id, protocolId, date);
  if (res.code === "42501") return fail("forbidden", 403, "Bara administratörer kan ändra inlästa protokoll.");
  if (!res.ok) return fail("not_found", 404, "Protokollet finns inte.");
  return NextResponse.json({ ok: true, date }, { headers: noStore });
}
