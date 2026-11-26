import { NextResponse, type NextRequest } from "next/server";
import { GoalsSchema, MAX_GOALS } from "@/lib/dashboard/goals-input";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });
const FORBIDDEN = "Bara administratörer kan ändra föreningens mål.";

/**
 * Approve the förening's goals: body `{ goals: [{ title, why? }] }` (0–5, in order) replaces the
 * current set (0028 `set_org_goals`, admins only). The goals come back from the browser, so they
 * are validated again here; the function checks the admin role itself too.
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

  const body = (await request.json().catch(() => null)) as { goals?: unknown } | null;
  const parsed = GoalsSchema.safeParse(body?.goals);
  if (!parsed.success) {
    return fail("bad_request", 400, `Varje mål behöver en titel (högst 80 tecken). Högst ${MAX_GOALS} mål.`);
  }

  const { error } = await db.rpc("set_org_goals", { p_org_id: id, p_goals: parsed.data });
  if (error) {
    if (error.code === "42501") return fail("forbidden", 403, FORBIDDEN);
    console.error(`goals: set_org_goals: ${error.message}`.slice(0, 200));
    return fail("save_failed", 500, "Målen kunde inte sparas. Försök igen.");
  }
  return NextResponse.json({ ok: true, count: parsed.data.length }, { headers: noStore });
}
