import { NextResponse, type NextRequest } from "next/server";
import { apiT, localizeMessage, requestLocale } from "@/lib/i18n/api";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { extractArsmoteItems } from "@/lib/formats/stadgar";
import { readStadgarFile } from "@/lib/formats/stadgar-file";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Onboarding step 4: the stadgar → the Årsmöte's agenda, in one Claude call (todo #15: the stadgar
 * are for the årsmöte only). Body `{ fileId }` (a Doc or PDF the admin picked). → `{ arsmote }`.
 * Stores nothing: the admin checks the list and saves it with POST …/onboarding/formats.
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

  const body = (await request.json().catch(() => null)) as { fileId?: unknown } | null;
  const fileId = typeof body?.fileId === "string" ? body.fileId : "";
  if (!DRIVE_ID.test(fileId)) return fail("bad_request", 400, t("api.pickStatutesAgain"));

  const file = await readStadgarFile(user.id, fileId, "onboarding/stadgar");
  if (!file.ok) return fail(file.error, file.status, localizeMessage(file.message, requestLocale(request)));

  const res = await extractArsmoteItems(file.input, { orgId: id });
  if (!res.ok) {
    if (res.error === "spend") return fail("spend", 503, t("api.statutesSpend"));
    return fail(res.error, 502, t("api.statutesFailed"));
  }
  console.info(`onboarding/stadgar: ${file.input.kind}, ${res.items.length} annual-meeting items`);
  return NextResponse.json({ arsmote: res.items }, { headers: noStore });
}
