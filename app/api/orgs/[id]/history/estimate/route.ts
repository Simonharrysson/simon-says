import { NextResponse, type NextRequest } from "next/server";
import { apiT, requestLocale } from "@/lib/i18n/api";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { DriveAccessMissingError, getGoogleAuth, getImportGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { estimateImport } from "@/lib/history/cost";
import { MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { MAX_BATCH_PROTOCOLS, reasonMessage } from "@/lib/history/progress";
import { googleStatus } from "@/lib/history/read-doc";
import { readPickedDocs } from "@/lib/history/read-picked";
import { historySummary, ownDocIds, transcriptTabIds } from "@/lib/history/store";
import { checkTicket } from "@/lib/history/ticket";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Up to MAX_IMPORT_DOCS Docs read (six at a time) to measure them.
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

export type EstimateDoc = { docId: string; sections: number } | { docId: string; error: string; message: string };

/**
 * Before an import: reads the picked Docs (admin's own grant) only to split and measure them,
 * and returns what reading them with Claude would cost. No Claude call, nothing stored, nothing
 * sent anywhere: the admin has not confirmed yet. A Doc can hold several meetings (one section
 * each); Simon Says' own Docs and Docs with no reliable split are refused per Doc. Body
 * `{ docIds }` (1–MAX_IMPORT_DOCS), at most MAX_BATCH_PROTOCOLS meetings. → `{ docs, protocols,
 * mode, importUsd, digestUsd, totalUsd }`: up to DIRECT_MAX meetings are read directly, more go
 * in one Anthropic batch at half price (lib/history/progress.ts).
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
  if (role !== "admin") return fail("forbidden", 403, t("api.historyAdminsOnly"));

  const body = (await request.json().catch(() => null)) as { docIds?: unknown; tickets?: unknown } | null;
  const raw = body?.docIds;
  const docIds = Array.isArray(raw) ? [...new Set(raw)] : [];
  if (!docIds.length || docIds.length > MAX_IMPORT_DOCS || !docIds.every((d): d is string => typeof d === "string" && DRIVE_ID.test(d))) {
    return fail("bad_request", 400, t("api.pickProtocols", { max: MAX_IMPORT_DOCS }));
  }
  // From the folder browser: every file needs the ticket its listing signed, and is read with the
  // import's read access. Without tickets (the Picker): the sign-in grant (drive.file).
  const tickets = body?.tickets && typeof body.tickets === "object" ? (body.tickets as Record<string, unknown>) : null;
  if (tickets && !docIds.every((d) => checkTicket(tickets[d], user.id, id, d))) {
    return fail("stale_list", 400, t("api.staleList"));
  }

  let own: Set<string>;
  let skipTabIds: Set<string>;
  let ownMeetings: number;
  let imported: number;
  try {
    const [o, t, m, h] = await Promise.all([
      ownDocIds(db, id, docIds),
      transcriptTabIds(db, id),
      db.from("meetings").select("id", { count: "exact", head: true }).eq("org_id", id).eq("is_test", false).in("status", ["done", "abandoned"]),
      historySummary(db, id).catch(() => ({ count: 0 })),
    ]);
    own = o;
    skipTabIds = t;
    ownMeetings = m.count ?? 0;
    imported = h.count;
  } catch (err) {
    console.error(`history/estimate: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }

  const docs: EstimateDoc[] = [];
  const chars: number[] = [];
  try {
    const auth = tickets ? await getImportGoogleAuth(user.id) : await getGoogleAuth(user.id);
    for (const d of await readPickedDocs(auth, docIds, { own, skipTabIds })) {
      if (!d.ok) {
        docs.push({ docId: d.docId, error: d.reason, message: reasonMessage(d.reason, requestLocale(request)) ?? "" });
        continue;
      }
      docs.push({ docId: d.docId, sections: d.sections.length });
      chars.push(...d.sections.map((s) => s.text.length));
    }
  } catch (err) {
    if (err instanceof DriveAccessMissingError) return fail("needs_drive_access", 403, t("api.driveAccessExpired"));
    if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, t("api.googleAuthLost"));
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("doc_unreadable", 403, t("api.docUnreadable"));
    console.error(`history/estimate: docs: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }
  if (chars.length > MAX_BATCH_PROTOCOLS) return fail("too_many", 400, t("api.tooManyMeetings", { count: chars.length, max: MAX_BATCH_PROTOCOLS }));
  // The digest reads every meeting: these, the ones already imported and Simon Says' own.
  const e = estimateImport(chars, ownMeetings + imported);
  console.info(`history/estimate: ${docIds.length} docs, ${chars.length} protocols, ${docs.filter((d) => "error" in d).length} refused`);
  return NextResponse.json({ docs, protocols: e.protocols, mode: e.mode, importUsd: e.importUsd, digestUsd: e.digestUsd, totalUsd: e.totalUsd }, { headers: noStore });
}
