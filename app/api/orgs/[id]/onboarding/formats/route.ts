import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { arsmoteProfile } from "@/lib/formats/arsmote-profile";
import { parseProfile } from "@/lib/formats/schema";
import { cleanItems } from "@/lib/formats/stadgar";
import { STYRELSEPROTOKOLL } from "@/lib/formats/standard";
import { chooseStandardFormat, orgDefaultFormat } from "@/lib/formats/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/**
 * Onboarding step 4, saved. Body `{ weekly?: true, board?: string[], arsmote?: string[] }`:
 * - weekly: Veckomöte becomes the default when the förening has none yet (a new förening runs
 *   Enkel until then; a format it already chose or learned is kept);
 * - board: the stadgar's Styrelsemöte items → the förening's own Styrelseprotokoll (non-default);
 * - arsmote: the stadgar's Årsmöte agenda → the förening's own Årsmöte (non-default); an empty
 *   list stores nothing, so Förbered möte keeps the standard Årsmöte.
 * Admins only (the DB functions check again). Items come back from the browser: cleaned again.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));
  if (!isUuid(id)) return fail("not_found", 404, t("api.orgNotFound"));
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, t("api.orgNotFound"));
  if (role !== "admin") return fail("forbidden", 403, t("api.formatAdminsOnly"));

  const body = (await request.json().catch(() => null)) as { weekly?: unknown; board?: unknown; arsmote?: unknown } | null;
  const board = body?.board === undefined ? null : strings(body.board);
  const arsmote = body?.arsmote === undefined ? null : strings(body.arsmote);
  if ((body?.board !== undefined && !board) || (body?.arsmote !== undefined && !arsmote)) return fail("bad_request", 400, t("api.invalidItems"));

  try {
    if (body?.weekly === true) {
      const current = await orgDefaultFormat(db, id);
      if (!current.id) await chooseStandardFormat(db, id, "veckomote");
    }
    let styrelse: unknown = null;
    if (board) {
      styrelse = parseProfile({ ...STYRELSEPROTOKOLL, requiredItems: cleanItems(board) });
      if (!styrelse) return fail("invalid_profile", 400, t("api.invalidItems"));
    }
    const ars = arsmote && arsmote.length > 0 ? arsmoteProfile(arsmote) : null;
    if (styrelse || ars) {
      // One transaction; saving the same lists again reuses the rows (set_type_formats, 0035).
      const { error } = await db.rpc("set_type_formats", { p_org_id: id, p_styrelse: styrelse, p_arsmote: ars });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
    }
  } catch (err) {
    if ((err as { code?: string }).code === "42501") return fail("forbidden", 403, t("api.formatAdminsOnly"));
    console.error(`onboarding/formats: ${(err as Error).message}`.slice(0, 200));
    return fail("save_failed", 500, t("api.formatsSaveFailed"));
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}
