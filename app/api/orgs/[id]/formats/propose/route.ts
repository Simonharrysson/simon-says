import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { proposeFormat } from "@/lib/formats/learn";
import { docStructure, firstNames, recurringOnly, type DocStructure } from "@/lib/formats/structure";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { docsApi, driveApi } from "@/lib/google/docs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Claude call with thinking (learn.ts), after up to five Doc reads.
export const maxDuration = 120;

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
 * → `{ profile, explanation, qualityNote, folderId }` (folderId: the parent folder of the first
 * picked Doc that is not a template, else of the first Doc).
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

  const body = (await request.json().catch(() => null)) as { docIds?: unknown } | null;
  const raw = body?.docIds;
  const docIds = Array.isArray(raw) ? [...new Set(raw)] : [];
  if (
    !Array.isArray(raw) ||
    docIds.length < 1 ||
    raw.length > MAX_DOCS ||
    !docIds.every((d): d is string => typeof d === "string" && DRIVE_ID.test(d))
  ) {
    return fail("bad_request", 400, t("api.pickDocs", { max: MAX_DOCS }));
  }

  // The org's people: a label holding one of their first names never leaves a Doc (privacy).
  const { data: people, error: peopleError } = await db.from("people").select("name").eq("org_id", id);
  if (peopleError) {
    console.error(`formats/propose: people: ${peopleError.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  const names = firstNames(((people ?? []) as { name: string }[]).map((p) => p.name));

  let docs: { isTemplate: boolean; structure: DocStructure }[];
  let folderId: string | null = null;
  try {
    const auth = await getGoogleAuth(user.id);
    const api = docsApi(auth);
    docs = await Promise.all(
      docIds.map(async (documentId) => {
        const doc = (await api.documents.get({ documentId, includeTabsContent: true })).data;
        return { isTemplate: TEMPLATE.test((doc.title ?? "").trim()), structure: docStructure(doc, { names }) };
      }),
    );
    // More than one Doc: only the labels they share (one-off text stays in its Doc).
    const shared = recurringOnly(docs.map((d) => d.structure));
    docs = docs.map((d, i) => ({ ...d, structure: shared[i] }));
    try {
      // The meeting folder: where the old minutes live, not a template's folder ("Mallar").
      const minutesIdx = docs.findIndex((d) => !d.isTemplate);
      const folderSource = docIds[minutesIdx >= 0 ? minutesIdx : 0];
      const file = await driveApi(auth).files.get({ fileId: folderSource, fields: "parents", supportsAllDrives: true });
      const parent = file.data.parents?.[0];
      folderId = parent && DRIVE_ID.test(parent) ? parent : null;
    } catch (err) {
      console.error(`formats/propose: parents: ${(err as Error).message}`.slice(0, 200));
    }
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, t("api.googleAuthLost"));
    }
    const status = googleStatus(err);
    if (status === 403 || status === 404) {
      return fail("doc_unreadable", 403, t("api.docUnreadablePick"));
    }
    // The message only: never Doc text or titles.
    console.error(`formats/propose: docs: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }

  const templates = docs.filter((d) => d.isTemplate).length;
  console.info(`formats/propose: ${docs.length} docs, ${templates} templates, ${docs.reduce((n, d) => n + d.structure.topItems.length, 0)} items`);

  const res = await proposeFormat({ orgId: id, docs });
  if (!res.ok) {
    if (res.error === "spend") {
      return fail("spend", 503, t("api.formatSpend"));
    }
    return fail(res.error, 502, t("api.formatFailed"));
  }
  return NextResponse.json(
    { profile: res.profile, explanation: res.explanation, qualityNote: res.qualityNote, folderId },
    { headers: noStore },
  );
}
