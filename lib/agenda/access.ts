import type { OAuth2Client } from "google-auth-library";
import { driveApi } from "@/lib/google/docs";

// Can the starter's own Google grant (drive.file: only files they picked or we created) write the
// agenda Doc they picked? Spec "Builder check — answers" 1: always the starter's token. Read only.

const DOC_MIME = "application/vnd.google-apps.document";

export type AgendaAccess =
  | { ok: true; name: string }
  | { ok: false; error: "not_found" | "not_doc" | "no_edit" | "trashed" };

const statusOf = (err: unknown): number => {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  return Number(e?.response?.status ?? e?.status ?? e?.code);
};

type ApiError = { errors?: { reason?: unknown }[]; response?: { data?: { error?: { errors?: { reason?: unknown }[] } } } };
/** The first Google API error reason ("rateLimitExceeded", "insufficientFilePermissions", …), if any. */
const reasonOf = (err: unknown): string | null => {
  const e = err as ApiError;
  const r = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.errors?.[0]?.reason;
  return typeof r === "string" ? r : null;
};

/** 403 reasons that mean "this grant can't see or use the file": the user picks it again. */
const NO_ACCESS = new Set([
  "forbidden",
  "notFound",
  "insufficientPermissions",
  "insufficientFilePermissions",
  "appNotAuthorizedToFile",
]);

/**
 * The picked Doc's name when it is a Google Doc the starter can edit. A file the grant cannot see
 * (never picked, deleted, no access) is `not_found`; any other Drive error is thrown.
 */
export async function checkAgendaDoc(auth: OAuth2Client, docId: string): Promise<AgendaAccess> {
  let file;
  try {
    file = (
      await driveApi(auth).files.get({
        fileId: docId,
        fields: "id,name,mimeType,trashed,capabilities(canEdit)",
        supportsAllDrives: true,
      })
    ).data;
  } catch (err) {
    // 404: not visible to this grant; a 403 for lack of access reads the same to the user. A 403
    // for a rate limit (userRateLimitExceeded, rateLimitExceeded) or any other reason is thrown:
    // the caller says "Google is unavailable, try again".
    const status = statusOf(err);
    if (status === 404) return { ok: false, error: "not_found" };
    if (status === 403) {
      const reason = reasonOf(err);
      if (reason === null || NO_ACCESS.has(reason)) return { ok: false, error: "not_found" };
    }
    throw err;
  }
  if (file.trashed) return { ok: false, error: "trashed" };
  if (file.mimeType !== DOC_MIME) return { ok: false, error: "not_doc" };
  if (file.capabilities?.canEdit !== true) return { ok: false, error: "no_edit" };
  return { ok: true, name: file.name ?? "" };
}
