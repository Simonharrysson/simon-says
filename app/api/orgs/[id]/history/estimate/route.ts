import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { estimateImport } from "@/lib/history/cost";
import { MAX_DOC_CHARS } from "@/lib/history/extract-prompt";
import { MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { googleStatus, readProtocolDoc } from "@/lib/history/read-doc";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

const PARALLEL = 6;

/**
 * Before an import: reads the picked protocols (admin's own grant) only to measure them, and
 * returns what reading them with Claude would cost. No Claude call, nothing stored, nothing sent
 * anywhere: the admin has not confirmed yet. Body `{ docIds }` (1–60).
 * → `{ protocols, tooLong, importUsd, digestUsd, totalUsd }`.
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

  const chars: number[] = [];
  let tooLong = 0;
  try {
    const auth = await getGoogleAuth(user.id);
    for (let i = 0; i < docIds.length; i += PARALLEL) {
      const part = await Promise.all(docIds.slice(i, i + PARALLEL).map(async (d) => (await readProtocolDoc(auth, d)).text.length));
      for (const n of part) {
        if (n > MAX_DOC_CHARS) tooLong++;
        else chars.push(n);
      }
    }
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("doc_unreadable", 403, "Simon Says kan inte läsa ett av dokumenten. Välj dem igen i Google-väljaren.");
    console.error(`history/estimate: docs: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
  const e = estimateImport(chars);
  console.info(`history/estimate: ${docIds.length} docs, ${tooLong} too long`);
  return NextResponse.json({ protocols: e.protocols, tooLong, importUsd: e.importUsd, digestUsd: e.digestUsd, totalUsd: e.totalUsd }, { headers: noStore });
}
