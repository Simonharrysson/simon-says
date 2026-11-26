import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { importOneSection } from "@/lib/history/import-one";
import { checkTicket } from "@/lib/history/ticket";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Doc read and ONE Claude call (one meeting); the extraction itself times out at 110 s.
export const maxDuration = 180;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Imports ONE meeting of a picked Doc: `{ docId, section, sections }` (a Doc can hold several
 * meetings, see lib/history/doc-text.ts; the browser loops over every section the estimate
 * found, so the admin sees progress and every request is one Claude call). Admins only, at most
 * 60 per förening per 24 h (claim_history_import; the claim is given back only when the spend
 * gate stopped the call before any request). Simon Says' own Docs are refused. Sends the section's text to Claude (the admin
 * confirmed that), stores only the cleaned items: never the text or the title. Logs only counts.
 * → `{ protocolId, date, dateFrom, decisions, tasks, reports }`.
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
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");

  const body = (await request.json().catch(() => null)) as { docId?: unknown; section?: unknown; sections?: unknown; ticket?: unknown } | null;
  const docId = body?.docId;
  const section = body?.section ?? 0;
  const sections = body?.sections ?? 1;
  if (
    typeof docId !== "string" ||
    !DRIVE_ID.test(docId) ||
    !Number.isInteger(section) ||
    !Number.isInteger(sections) ||
    (section as number) < 0 ||
    (section as number) >= (sections as number) ||
    (sections as number) > 60
  ) {
    return fail("bad_request", 400, "Välj ett protokoll.");
  }
  // A ticket (from the folder browser's listing) means: read with the import's read access. It
  // must be valid for exactly this file; without one, the sign-in grant (drive.file, the Picker).
  const viaListing = body?.ticket !== undefined;
  if (viaListing && !checkTicket(body?.ticket, user.id, id, docId)) {
    return fail("stale_list", 400, "Listan är för gammal. Gå tillbaka och visa mötena i mapparna igen.");
  }
  const res = await importOneSection(db, { userId: user.id, orgId: id, docId, section: section as number, sections: sections as number, viaListing });
  if (!res.ok) return fail(res.error, res.status, res.message);
  const { ok: _ok, ...out } = res;
  return NextResponse.json(out, { headers: noStore });
}
