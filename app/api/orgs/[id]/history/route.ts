import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { validDate } from "@/lib/history/extract-prompt";
import { setProtocolDate } from "@/lib/history/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/** Removes every imported protocol of the förening (admins only, 0032 clear_history_protocols). */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, t("api.orgNotFound"));
  if (role !== "admin") return fail("forbidden", 403, t("api.historyDeleteAdminsOnly"));
  const { data, error } = await db.rpc("clear_history_protocols", { p_org_id: id });
  if (error) {
    if (error.code === "42501") return fail("forbidden", 403, t("api.historyDeleteAdminsOnly"));
    console.error(`history: clear: ${error.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  // Finished imports go too (their file names with them); an open one keeps running.
  const { error: jobsError } = await supabaseAdmin()
    .from("history_import_jobs")
    .delete()
    .eq("org_id", id)
    .in("status", ["done", "canceled", "failed"]);
  if (jobsError) console.error(`history: clear jobs: ${jobsError.message}`.slice(0, 200));
  return NextResponse.json({ ok: true, removed: data ?? 0 }, { headers: noStore });
}

/**
 * Corrects an imported protocol's date (one that fell back to the Doc's creation date): body
 * `{ protocolId, date }`. Admins only (0032 set_history_protocol_date); not in the future.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, t("api.orgNotFound"));
  if (role !== "admin") return fail("forbidden", 403, t("api.historyEditAdminsOnly"));
  const body = (await request.json().catch(() => null)) as { protocolId?: unknown; date?: unknown } | null;
  const protocolId = body?.protocolId;
  const date = typeof body?.date === "string" ? validDate(body.date) : null;
  if (typeof protocolId !== "string" || !isUuid(protocolId) || !date) return fail("bad_request", 400, t("api.futureDate"));
  const res = await setProtocolDate(db, id, protocolId, date);
  if (res.code === "42501") return fail("forbidden", 403, t("api.historyEditAdminsOnly"));
  if (!res.ok) return fail("not_found", 404, t("api.protocolNotFound"));
  return NextResponse.json({ ok: true, date }, { headers: noStore });
}
