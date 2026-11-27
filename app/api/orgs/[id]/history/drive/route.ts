import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { deleteImportToken, DriveAccessMissingError, getImportGoogleAuth, hasImportAccess } from "@/lib/google/client";
import { driveApi } from "@/lib/google/docs";
import {
  isInsufficientScope,
  listFilesInFolders,
  listFolders,
  MAX_PICKED_FOLDERS,
  resolveFolders,
  type DriveLike,
  type FolderPlace,
  type ImportFile,
} from "@/lib/history/drive-list";
import { googleStatus } from "@/lib/history/read-doc";
import { ownDocIds } from "@/lib/history/store";
import { fileTicket } from "@/lib/history/ticket";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });


type Body =
  | { action: "folders"; place?: unknown; id?: unknown; driveId?: unknown; query?: unknown; pageToken?: unknown }
  | { action: "files"; folders?: unknown; subfolders?: unknown };

function place(b: Extract<Body, { action: "folders" }>): FolderPlace | null {
  const driveId = typeof b.driveId === "string" && DRIVE_ID.test(b.driveId) ? b.driveId : undefined;
  if (b.driveId !== undefined && !driveId) return null;
  switch (b.place) {
    case "root":
    case "shared":
    case "drives":
      return { place: b.place };
    case "folder":
      return typeof b.id === "string" && DRIVE_ID.test(b.id) ? { place: "folder", id: b.id, ...(driveId ? { driveId } : {}) } : null;
    case "search":
      return typeof b.query === "string" && b.query.trim().length >= 1 && b.query.length <= 100 ? { place: "search", query: b.query } : null;
    default:
      return null;
  }
}

/**
 * The import's own Drive browser (no Google Picker). Admins of the förening only, with their OWN
 * Google import grant (google_import_tokens: drive.readonly, under 24 h); otherwise
 * 403 `needs_drive_access` and the page asks for it. At most 120 folders listed per user per
 * 10 min (0034 claim_drive_listing). Each importable file carries a signed ticket: the only way
 * the estimate and import routes will read it with the read access. Reads metadata only; nothing is stored; logs counts only.
 *
 * `{ action: "folders", place: "root" | "shared" | "drives" | "folder" | "search", id?, driveId?, query?, pageToken? }`
 *   → `{ folders: [{ id, name, driveId? }], nextPageToken }`
 * `{ action: "files", folders: [{ id }] (1–20), subfolders }`
 *   → `{ files: ImportFile[], truncated, folders }` (already imported → "imported"; Simon Says'
 *   own meeting Docs → "own").
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
  if (role !== "admin") return fail("forbidden", 403, t("api.historyAdminsOnly"));

  const body = (await request.json().catch(() => null)) as Body | null;
  let at: FolderPlace | null = null;
  let picked: { id: string }[] = [];
  if (body?.action === "folders") {
    at = place(body);
    if (!at || (body.pageToken !== undefined && (typeof body.pageToken !== "string" || body.pageToken.length > 500))) {
      return fail("bad_request", 400, t("api.pickFolder"));
    }
  } else if (body?.action === "files") {
    const raw = Array.isArray(body.folders) ? body.folders : [];
    picked = [...new Set(raw.map((f) => (f as { id?: unknown })?.id))].filter((x): x is string => typeof x === "string" && DRIVE_ID.test(x)).map((x) => ({ id: x }));
    if (!picked.length || picked.length !== raw.length || picked.length > MAX_PICKED_FOLDERS) {
      return fail("bad_request", 400, t("api.pickFolders", { max: MAX_PICKED_FOLDERS }));
    }
  } else {
    return fail("bad_request", 400, t("api.pickFolder"));
  }

  try {
    if (!(await hasImportAccess(user.id))) return fail("needs_drive_access", 403, t("api.needsDriveAccess"));
  } catch (err) {
    console.error(`history/drive: access: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }

  // One claim per folder listed: the browser's one, or each ticked folder now and the
  // subfolders found below them after the walk.
  const { data: allowed, error: claimError } = await db.rpc("claim_drive_listing", { p_org_id: id, p_count: at ? 1 : picked.length });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, t("api.historyAdminsOnly"));
    console.error(`history/drive: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  if (allowed !== true) return fail("rate_limited", 429, t("api.browseRateLimited"));

  try {
    const auth = await getImportGoogleAuth(user.id);
    const api = driveApi(auth) as unknown as DriveLike;
    if (at) {
      const r = await listFolders(api, at, body?.action === "folders" && typeof body.pageToken === "string" ? body.pageToken : undefined);
      console.info(`history/drive: folders (${at.place}): ${r.folders.length}`);
      return NextResponse.json(r, { headers: noStore });
    }
    const roots = await resolveFolders(api, picked);
    const r = await listFilesInFolders(api, roots, { subfolders: body?.action === "files" && body.subfolders === true });
    const extra = Math.min(100, r.folders - picked.length);
    if (extra > 0) {
      // Charged after the fact (the walk is already capped at 60 folders); a full budget only
      // means the next listing waits.
      const { error } = await db.rpc("claim_drive_listing", { p_org_id: id, p_count: extra });
      if (error) console.error(`history/drive: claim subfolders: ${error.message}`.slice(0, 200));
    }
    const ids = r.files.map((f) => f.id);
    const [own, imported] = await Promise.all([inChunks(ids, (part) => ownDocIds(db, id, part)), inChunks(ids, (part) => importedDocIds(db, id, part))]);
    const files: ImportFile[] = r.files.map((f) => {
      const status = own.has(f.id) ? "own" : imported.has(f.id) ? "imported" : f.status;
      // Only files the import may read get a ticket (never Simon Says' own, never .docx).
      return status === "own" || status === "docx" ? { ...f, status } : { ...f, status, ticket: fileTicket(user.id, id, f.id) };
    });
    console.info(`history/drive: files: ${files.length} in ${r.folders} folders${r.truncated ? " (truncated)" : ""}`);
    return NextResponse.json({ files, truncated: r.truncated, folders: r.folders }, { headers: noStore });
  } catch (err) {
    if (err instanceof DriveAccessMissingError || isInsufficientScope(err)) return fail("needs_drive_access", 403, t("api.needsDriveAccess"));
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("folder_unreadable", 404, t("api.folderUnreadable"));
    if (status === 429) return fail("google_busy", 503, t("api.googleBusy"));
    console.error(`history/drive: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }
}

/** "Ta bort läsåtkomst": deletes our copy of the admin's import grant (not revoked at Google: that would end the sign-in grant too). */
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
  try {
    await deleteImportToken(user.id);
  } catch (err) {
    console.error(`history/drive: delete: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

/** `fn` over `ids` in slices of 100 (keeps PostgREST's `in.(…)` URL short), results merged. */
async function inChunks(ids: string[], fn: (part: string[]) => Promise<Set<string>>): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) for (const x of await fn(ids.slice(i, i + 100))) out.add(x);
  return out;
}

/** Drive ids among `ids` already imported for the förening (history_protocols, RLS: members). */
async function importedDocIds(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await db.from("history_protocols").select("drive_file_id").eq("org_id", orgId).in("drive_file_id", ids);
  if (error) throw new Error(`history: imported ids: ${error.message}`);
  return new Set(((data ?? []) as { drive_file_id: string }[]).map((r) => r.drive_file_id));
}
