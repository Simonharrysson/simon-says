import type { OAuth2Client } from "google-auth-library";
import { driveApi } from "@/lib/google/docs";

// Agenda-Doc candidates in the förening's meeting folder (A11), read with the starter's own grant.
// File names are the förening's text: never logged.

const DOC_MIME = "application/vnd.google-apps.document";
/** Drive ids are URL-safe base64-ish; anything else never reaches the `q` string. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const WEEK_MS = 7 * 86_400_000;
const TZ = "Europe/Stockholm";

export interface DriveDoc {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const MONTHS_LONG = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** The Stockholm calendar date of an instant. */
function stockholmDate(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Days since the epoch of the Monday of a calendar date's ISO week (compares weeks across years). */
function mondayOf(date: { y: number; m: number; d: number }): number {
  const day = Math.floor(Date.UTC(date.y, date.m - 1, date.d) / 86_400_000);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  return day - ((day + 3) % 7);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Matches today's date in a title: 2026-11-25, 20261125, 25/11, 25.11, 25 nov, 25 november. */
function todayPattern(now: Date): RegExp {
  const { y, m, d } = stockholmDate(now);
  const day = `0?${d}`;
  const mon = `0?${m}`;
  const forms = [
    `${y}-${pad(m)}-${pad(d)}`,
    `${y}${pad(m)}${pad(d)}`,
    `${day}/${mon}`,
    `${day}\\.${mon}`,
    `${day} (?:${MONTHS_LONG[m - 1]}|${MONTHS[m - 1]})(?![a-zåäö])`,
  ];
  return new RegExp(`(?<!\\d)(?:${forms.join("|")})(?!\\d)`, "i");
}

/**
 * Best first: today's date (Stockholm) in the title > created in the current ISO week
 * (Stockholm) > newer `modifiedTime`. Pure; returns a new array.
 */
export function rankCandidates<T extends DriveDoc>(files: T[], now: Date): T[] {
  const today = todayPattern(now);
  const thisWeek = mondayOf(stockholmDate(now));
  const score = (f: T) => ({
    dated: today.test(f.name) ? 1 : 0,
    // A missing or bad createdTime is "not this week" (Intl throws on an Invalid Date).
    week: Number.isFinite(Date.parse(f.createdTime)) && mondayOf(stockholmDate(new Date(f.createdTime))) === thisWeek ? 1 : 0,
    modified: Date.parse(f.modifiedTime) || 0,
  });
  return files
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s.dated - a.s.dated || b.s.week - a.s.week || b.s.modified - a.s.modified)
    .map(({ f }) => f);
}

const statusOf = (err: unknown): number => {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  return Number(e?.response?.status ?? e?.status ?? e?.code);
};
type ApiError = { errors?: { reason?: unknown }[]; response?: { data?: { error?: { errors?: { reason?: unknown }[] } } } };
const reasonOf = (err: unknown): string | null => {
  const e = err as ApiError;
  const r = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.errors?.[0]?.reason;
  return typeof r === "string" ? r : null;
};
/** 403 reasons that mean "this grant can't see the folder" (as lib/agenda/access.ts). */
const NO_ACCESS = new Set(["forbidden", "notFound", "insufficientPermissions", "insufficientFilePermissions", "appNotAuthorizedToFile"]);

/** Titles of the fictional agenda Testmöte Docs (lib/testmeeting/agenda.ts): never a candidate. */
export const TEST_DOC_SUFFIX = "(Testmöte)";

/**
 * The folder's Google Docs modified in the last 7 days, minus Docs already used by a meeting and
 * test agenda Docs (an orphaned one must never be offered for a real meeting), ranked. A folder this grant cannot see (drive.file: never picked by this user) is
 * `accessible: false`; any other Drive error is thrown.
 */
export async function listCandidates(
  auth: OAuth2Client,
  folderId: string,
  usedDocIds: Set<string>,
  now: Date,
): Promise<{ accessible: boolean; candidates: DriveDoc[] }> {
  if (!DRIVE_ID.test(folderId)) throw new Error("listCandidates: invalid folder id");
  const drive = driveApi(auth);
  try {
    await drive.files.get({ fileId: folderId, fields: "id", supportsAllDrives: true });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return { accessible: false, candidates: [] };
    if (status === 403) {
      const reason = reasonOf(err);
      if (reason === null || NO_ACCESS.has(reason)) return { accessible: false, candidates: [] };
    }
    throw err;
  }
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='${DOC_MIME}' and trashed=false and modifiedTime > '${since}'`,
    fields: "files(id,name,createdTime,modifiedTime)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = (res.data.files ?? [])
    .filter((f) => f.id && !usedDocIds.has(f.id) && !(f.name ?? "").trim().endsWith(TEST_DOC_SUFFIX))
    .map((f) => ({
      id: f.id!,
      name: f.name ?? "",
      createdTime: f.createdTime ?? "",
      modifiedTime: f.modifiedTime ?? "",
    }));
  return { accessible: true, candidates: rankCandidates(files, now) };
}
