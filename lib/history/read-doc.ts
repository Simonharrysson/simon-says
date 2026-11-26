import "server-only";
import type { OAuth2Client } from "google-auth-library";
import { docsApi, driveApi } from "@/lib/google/docs";
import { docTabs, splitProtocols, type SplitResult } from "./doc-text";

// Reads one picked protocol with the admin's own Google grant (drive.file: the Picker granted
// exactly the picked files). The text goes to the extraction call only; never stored or logged.

/**
 * The picked Doc split into one section per meeting (see doc-text.ts). Transcript tabs are never
 * read: by title, and by id (`skipTabIds`, the org's meetings' transcript tabs). The Doc's last
 * edit is the reference for meeting headings without a year.
 */
export async function readProtocolDoc(
  auth: OAuth2Client,
  documentId: string,
  opts: { skipTabIds?: Set<string> } = {},
): Promise<{ title: string; split: SplitResult }> {
  const [doc, file] = await Promise.all([
    docsApi(auth).documents.get({ documentId, includeTabsContent: true }),
    driveApi(auth)
      .files.get({ fileId: documentId, fields: "modifiedTime", supportsAllDrives: true })
      .catch(() => null),
  ]);
  const title = (doc.data.title ?? "").trim();
  const modified = file?.data.modifiedTime;
  const referenceDate = modified && /^\d{4}-\d{2}-\d{2}/.test(modified) ? modified.slice(0, 10) : undefined;
  return { title, split: splitProtocols(title, docTabs(doc.data, opts.skipTabIds), { referenceDate }) };
}

/** The Drive file's creation date (YYYY-MM-DD), the fallback when the protocol holds no date. */
export async function fileCreatedDate(auth: OAuth2Client, fileId: string): Promise<string | null> {
  const file = await driveApi(auth).files.get({ fileId, fields: "createdTime", supportsAllDrives: true });
  const t = file.data.createdTime;
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

export const googleStatus = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const s = e?.response?.status ?? e?.status ?? e?.code;
  return typeof s === "number" ? s : undefined;
};
