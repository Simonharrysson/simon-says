import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { proposeFormat } from "@/lib/formats/learn";
import { docStructure, type DocStructure } from "@/lib/formats/structure";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { docsApi, driveApi } from "@/lib/google/docs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

const MAX_DOCS = 5;
const TEMPLATE = /^(mall|template)/i;

const googleStatus = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const s = e?.response?.status ?? e?.status ?? e?.code;
  return typeof s === "number" ? s : undefined;
};

/**
 * Propose a format from 1–5 Docs the admin picked (old minutes or a template). Body
 * `{ docIds }`. Reads each Doc with the admin's own Google grant, keeps only its structure
 * (lib/formats/structure.ts) and asks Claude for a profile. Stores nothing; logs only counts.
 * → `{ profile, explanation, qualityNote, folderId }` (folderId: the first Doc's parent folder).
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
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan byta mötesformat.");

  const body = (await request.json().catch(() => null)) as { docIds?: unknown } | null;
  const raw = body?.docIds;
  const docIds = Array.isArray(raw) ? [...new Set(raw)] : [];
  if (
    !Array.isArray(raw) ||
    docIds.length < 1 ||
    raw.length > MAX_DOCS ||
    !docIds.every((d): d is string => typeof d === "string" && DRIVE_ID.test(d))
  ) {
    return fail("bad_request", 400, `Välj mellan 1 och ${MAX_DOCS} dokument.`);
  }

  let docs: { isTemplate: boolean; structure: DocStructure }[];
  let folderId: string | null = null;
  try {
    const auth = await getGoogleAuth(user.id);
    const api = docsApi(auth);
    docs = await Promise.all(
      docIds.map(async (documentId) => {
        const doc = (await api.documents.get({ documentId, includeTabsContent: true })).data;
        return { isTemplate: TEMPLATE.test((doc.title ?? "").trim()), structure: docStructure(doc) };
      }),
    );
    try {
      const file = await driveApi(auth).files.get({ fileId: docIds[0], fields: "parents", supportsAllDrives: true });
      const parent = file.data.parents?.[0];
      folderId = parent && DRIVE_ID.test(parent) ? parent : null;
    } catch (err) {
      console.error(`formats/propose: parents: ${(err as Error).message}`.slice(0, 200));
    }
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    const status = googleStatus(err);
    if (status === 403 || status === 404) {
      return fail("doc_unreadable", 403, "Simon Says kan inte läsa ett av dokumenten. Välj dem igen i Google-väljaren.");
    }
    // The message only: never Doc text or titles.
    console.error(`formats/propose: docs: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }

  const templates = docs.filter((d) => d.isTemplate).length;
  console.info(`formats/propose: ${docs.length} docs, ${templates} templates, ${docs.reduce((n, d) => n + d.structure.topItems.length, 0)} items`);

  const res = await proposeFormat({ orgId: id, docs });
  if (!res.ok) {
    if (res.error === "spend") {
      return fail("spend", 503, "Simon Says kan inte föreslå ett format just nu. Försök igen i morgon eller välj ett standardformat.");
    }
    return fail(res.error, 502, "Simon Says kunde inte föreslå ett format från dokumenten. Försök igen eller välj ett standardformat.");
  }
  return NextResponse.json(
    { profile: res.profile, explanation: res.explanation, qualityNote: res.qualityNote, folderId },
    { headers: noStore },
  );
}
