import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { estimateImport } from "@/lib/history/cost";
import { MANY_MEETINGS_MESSAGE } from "@/lib/history/doc-text";
import { MAX_DOC_CHARS } from "@/lib/history/extract-prompt";
import { MAX_IMPORT_DOCS, OWN_DOC_MESSAGE } from "@/lib/history/limits";
import { googleStatus, readProtocolDoc } from "@/lib/history/read-doc";
import { historySummary, ownDocIds, transcriptTabIds } from "@/lib/history/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

const PARALLEL = 6;

export type EstimateDoc = { docId: string; sections: number } | { docId: string; error: string; message: string };

/**
 * Before an import: reads the picked Docs (admin's own grant) only to split and measure them,
 * and returns what reading them with Claude would cost. No Claude call, nothing stored, nothing
 * sent anywhere: the admin has not confirmed yet. A Doc can hold several meetings (one section
 * each); Simon Says' own Docs and Docs with no reliable split are refused per Doc. Body
 * `{ docIds }` (1–60). → `{ docs, protocols, importUsd, digestUsd, totalUsd }`.
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

  const body = (await request.json().catch(() => null)) as { docIds?: unknown } | null;
  const raw = body?.docIds;
  const docIds = Array.isArray(raw) ? [...new Set(raw)] : [];
  if (!docIds.length || docIds.length > MAX_IMPORT_DOCS || !docIds.every((d): d is string => typeof d === "string" && DRIVE_ID.test(d))) {
    return fail("bad_request", 400, `Välj mellan 1 och ${MAX_IMPORT_DOCS} protokoll.`);
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
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }

  const docs: EstimateDoc[] = [];
  const chars: number[] = [];
  try {
    const auth = await getGoogleAuth(user.id);
    for (let i = 0; i < docIds.length; i += PARALLEL) {
      const part = await Promise.all(
        docIds.slice(i, i + PARALLEL).map(async (docId): Promise<{ doc: EstimateDoc; chars: number[] }> => {
          if (own.has(docId)) return { doc: { docId, error: "own_doc", message: OWN_DOC_MESSAGE }, chars: [] };
          const { split } = await readProtocolDoc(auth, docId, { skipTabIds });
          if (!split.ok) {
            const message = split.reason === "empty" ? "Dokumentet är tomt." : split.reason === "too-many" ? "Dokumentet innehåller fler än 60 möten." : MANY_MEETINGS_MESSAGE;
            return { doc: { docId, error: split.reason, message }, chars: [] };
          }
          if (split.sections.some((s) => s.text.length > MAX_DOC_CHARS)) {
            return { doc: { docId, error: "too_long", message: "Ett av mötena i dokumentet är för långt för att vara ett protokoll." }, chars: [] };
          }
          return { doc: { docId, sections: split.sections.length }, chars: split.sections.map((s) => s.text.length) };
        }),
      );
      for (const p of part) {
        docs.push(p.doc);
        chars.push(...p.chars);
      }
    }
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("doc_unreadable", 403, "Simon Says kan inte läsa ett av dokumenten. Kontrollera att du fortfarande har åtkomst till det i Google Drive och välj det igen.");
    console.error(`history/estimate: docs: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
  if (chars.length > MAX_IMPORT_DOCS) return fail("too_many", 400, `Dokumenten innehåller ${chars.length} möten. Välj högst ${MAX_IMPORT_DOCS} åt gången.`);
  // The digest reads every meeting: these, the ones already imported and Simon Says' own.
  const e = estimateImport(chars, ownMeetings + imported);
  console.info(`history/estimate: ${docIds.length} docs, ${chars.length} protocols, ${docs.filter((d) => "error" in d).length} refused`);
  return NextResponse.json({ docs, protocols: e.protocols, importUsd: e.importUsd, digestUsd: e.digestUsd, totalUsd: e.totalUsd }, { headers: noStore });
}
