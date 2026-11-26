import { DRIVE_ID } from "@/lib/agenda/candidates";
import { dateMarks } from "./doc-text";

// The protocol import's own Drive browser (no Google Picker): with the admin's drive.readonly
// grant, list folders (My Drive, shared with me, shared drives, a search) and the Google Docs in
// the folders the admin ticks. Only METADATA is read here (names, dates, parents): no Doc is
// opened until the admin ticks it and confirms, as the consent text promises. Nothing listed is
// stored; the route logs counts only. Pure over a minimal Drive client, so tests use a fake.

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Folders visited per file listing (the ticked ones plus subfolders). */
export const MAX_FOLDERS = 60;
/** Files returned per file listing. */
export const MAX_FILES = 500;
/** Folders ticked per file listing. */
export const MAX_PICKED_FOLDERS = 20;
const PAGE_SIZE = 200;
const MAX_PAGES_PER_FOLDER = 5;
const PARALLEL = 4;

interface DriveFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  driveId?: string | null;
  modifiedTime?: string | null;
  createdTime?: string | null;
  parents?: string[] | null;
}

/** The few Drive v3 calls we use (googleapis' drive_v3.Drive fits; tests pass a fake). */
export interface DriveLike {
  files: {
    list(params: Record<string, unknown>): Promise<{ data: { files?: DriveFile[] | null; nextPageToken?: string | null; incompleteSearch?: boolean | null } }>;
    get(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
  };
  drives: {
    list(params: Record<string, unknown>): Promise<{ data: { drives?: { id?: string | null; name?: string | null }[] | null; nextPageToken?: string | null } }>;
  };
}

export interface DriveFolder {
  id: string;
  name: string;
  /** The shared drive it lives in; absent in My Drive / shared with me. */
  driveId?: string;
}

/** Where the folder browser looks: a place, a folder, or a name search. */
export type FolderPlace = { place: "root" } | { place: "shared" } | { place: "drives" } | { place: "folder"; id: string; driveId?: string } | { place: "search"; query: string };

const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

/** A string literal inside a Drive `q`: backslash and single quote escaped. */
export function qString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const scope = (driveId?: string) => (driveId ? { corpora: "drive", driveId } : { corpora: "allDrives" });

/** One page of folders for the browser. Throws on a bad id (the route checks first). */
export async function listFolders(api: DriveLike, at: FolderPlace, pageToken?: string): Promise<{ folders: DriveFolder[]; nextPageToken: string | null }> {
  if (at.place === "drives") {
    const res = await api.drives.list({ pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    const folders = (res.data.drives ?? []).flatMap((d) => (d.id && d.name ? [{ id: d.id, name: d.name, driveId: d.id }] : []));
    return { folders, nextPageToken: res.data.nextPageToken ?? null };
  }
  const isFolder = `mimeType = '${FOLDER_MIME}' and trashed = false`;
  let q: string;
  let where: Record<string, unknown> = scope();
  if (at.place === "root") {
    q = `'root' in parents and ${isFolder}`;
    where = { corpora: "user" };
  } else if (at.place === "shared") {
    q = `sharedWithMe and ${isFolder}`;
    where = { corpora: "user" };
  } else if (at.place === "folder") {
    if (!DRIVE_ID.test(at.id) || (at.driveId && !DRIVE_ID.test(at.driveId))) throw new Error("listFolders: invalid id");
    q = `${qString(at.id)} in parents and ${isFolder}`;
    where = scope(at.driveId);
  } else {
    const query = at.query.trim().slice(0, 100);
    q = `name contains ${qString(query)} and ${isFolder}`;
  }
  const res = await api.files.list({
    q,
    ...where,
    ...ALL_DRIVES,
    pageSize: 100,
    orderBy: "name_natural",
    fields: "nextPageToken, files(id, name, driveId)",
    ...(pageToken ? { pageToken } : {}),
  });
  const folders = (res.data.files ?? []).flatMap((f) =>
    f.id && f.name ? [{ id: f.id, name: f.name, ...(f.driveId ? { driveId: f.driveId } : {}) }] : [],
  );
  return { folders, nextPageToken: res.data.nextPageToken ?? null };
}

/** Why a listed file is not ticked by default (or cannot be ticked). */
export type FileStatus = "ready" | "template" | "docx";

export interface ListedFile {
  id: string;
  name: string;
  folderId: string;
  folderName: string;
  /** YYYY-MM-DD: from the title, else the file's creation date. */
  date: string | null;
  /** The date is a guess (no year in the title, or none at all): the admin should check it. */
  dateInferred: boolean;
  status: FileStatus;
}

/** A row of the import's file list as the browser gets it: also already imported, or Simon Says' own Doc. */
export type ImportFile = Omit<ListedFile, "status"> & { status: FileStatus | "imported" | "own" };

const NOT_PROTOCOL = /(?<![\p{L}])(mall|template|kallelse|dagordning|agenda|exempel|example|instruktion(er)?|instructions?)(?![\p{L}])/iu;
const IS_PROTOCOL = /protokoll|minutes|protocol/i;

/** A title that looks like a template or an agenda, not a protocol ("Mall styrelseprotokoll" is a template). */
export function looksLikeNonProtocol(title: string): boolean {
  if (/(?<![\p{L}])(mall|template)(?![\p{L}])/iu.test(title)) return true;
  return NOT_PROTOCOL.test(title) && !IS_PROTOCOL.test(title);
}

const pad = (n: number) => String(n).padStart(2, "0");
function ymd(y: number, m: number, d: number): string | null {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}
const day = (t: string | null | undefined) => (t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null);

/**
 * The meeting date a title shows. A full date wins ("Protokoll 2025-09-02", "4 sep 2025",
 * "10/9-25"); then a compact one ("250902", "20250902"); a date without a year gets the year
 * that puts it on or before the file's last edit (flagged); none: the file's creation date
 * (flagged).
 */
export function titleDate(title: string, file: { modifiedTime?: string | null; createdTime?: string | null }): { date: string | null; inferred: boolean } {
  const marks = dateMarks(title);
  const full = marks.find((m) => m.iso);
  if (full?.iso) return { date: full.iso, inferred: false };
  const compact = /(?<!\d)(20\d\d)(\d\d)(\d\d)(?!\d)|(?<!\d)(\d\d)(\d\d)(\d\d)(?!\d)/.exec(title);
  if (compact) {
    const iso = compact[1] ? ymd(+compact[1], +compact[2], +compact[3]) : ymd(2000 + +compact[4], +compact[5], +compact[6]);
    if (iso) return { date: iso, inferred: false };
  }
  const ref = day(file.modifiedTime) ?? day(file.createdTime);
  const md = marks[0]?.md;
  if (md && ref) {
    const y = +ref.slice(0, 4);
    const at = (year: number) => ymd(year, +md.slice(0, 2), +md.slice(3));
    const same = at(y);
    const iso = same && same <= ref ? same : (at(y - 1) ?? same);
    if (iso) return { date: iso, inferred: true };
  }
  return { date: day(file.createdTime), inferred: true };
}

async function inParallel<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/** The ticked folders as Drive knows them (a non-folder or unknown id is an error). */
export async function resolveFolders(api: DriveLike, ids: { id: string }[]): Promise<DriveFolder[]> {
  return inParallel(ids, PARALLEL, async ({ id }) => {
    if (!DRIVE_ID.test(id)) throw new Error("resolveFolders: invalid id");
    const { data } = await api.files.get({ fileId: id, fields: "id, name, mimeType, driveId", supportsAllDrives: true });
    if (data.mimeType !== FOLDER_MIME || !data.id) throw Object.assign(new Error("not a folder"), { code: 404 });
    return { id: data.id, name: data.name ?? "Mapp", ...(data.driveId ? { driveId: data.driveId } : {}) };
  });
}

/**
 * Every Google Doc (and .docx, listed but not importable) in the given folders, and with
 * `subfolders` in the folders below them too, sorted by date (oldest first). Bounded: MAX_FOLDERS folders, MAX_FILES files (`truncated` when a cap was hit).
 */
export async function listFilesInFolders(
  api: DriveLike,
  roots: DriveFolder[],
  opts: { subfolders: boolean },
): Promise<{ files: ListedFile[]; truncated: boolean; folders: number }> {
  const seenFolders = new Set<string>();
  const seenFiles = new Set<string>();
  const files: ListedFile[] = [];
  let truncated = false;
  let queue = roots.filter((f) => !seenFolders.has(f.id) && seenFolders.add(f.id));
  const wanted = `mimeType = '${DOC_MIME}' or mimeType = '${DOCX_MIME}'${opts.subfolders ? ` or mimeType = '${FOLDER_MIME}'` : ""}`;

  while (queue.length) {
    const next: DriveFolder[] = [];
    await inParallel(queue, PARALLEL, async (folder) => {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_FOLDER; page++) {
        const res = await api.files.list({
          q: `${qString(folder.id)} in parents and trashed = false and (${wanted})`,
          ...scope(folder.driveId),
          ...ALL_DRIVES,
          pageSize: PAGE_SIZE,
          fields: "nextPageToken, incompleteSearch, files(id, name, mimeType, driveId, modifiedTime, createdTime)",
          ...(pageToken ? { pageToken } : {}),
        });
        // allDrives can answer with only part of the result: say so, never drop Docs silently.
        if (res.data.incompleteSearch) truncated = true;
        for (const f of res.data.files ?? []) {
          if (!f.id || !f.name) continue;
          if (f.mimeType === FOLDER_MIME) {
            if (seenFolders.has(f.id)) continue;
            if (seenFolders.size >= MAX_FOLDERS) {
              truncated = true;
              continue;
            }
            seenFolders.add(f.id);
            next.push({ id: f.id, name: f.name, ...(f.driveId ?? folder.driveId ? { driveId: (f.driveId ?? folder.driveId)! } : {}) });
            continue;
          }
          if (seenFiles.has(f.id)) continue;
          if (files.length >= MAX_FILES) {
            truncated = true;
            continue;
          }
          seenFiles.add(f.id);
          const { date, inferred } = titleDate(f.name, f);
          files.push({
            id: f.id,
            name: f.name,
            folderId: folder.id,
            folderName: folder.name,
            date,
            dateInferred: inferred,
            status: f.mimeType === DOCX_MIME ? "docx" : looksLikeNonProtocol(f.name) ? "template" : "ready",
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
        if (page === MAX_PAGES_PER_FOLDER - 1) truncated = true;
      }
    });
    queue = next;
  }
  files.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.name.localeCompare(b.name, "sv"));
  return { files, truncated, folders: seenFolders.size };
}

/** A Drive error that means the grant lacks the scope (drive.readonly was withdrawn). */
export function isInsufficientScope(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; message?: unknown; response?: { status?: unknown; data?: { error?: { errors?: { reason?: unknown }[] } } } };
  const status = e?.response?.status ?? e?.status ?? e?.code;
  if (status !== 403) return false;
  const reasons = (e?.response?.data?.error?.errors ?? []).map((r) => r?.reason);
  if (reasons.includes("insufficientPermissions") || reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return true;
  return typeof e?.message === "string" && /insufficient (authentication )?scopes?|insufficientPermissions/i.test(e.message);
}
