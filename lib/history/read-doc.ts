import "server-only";
import type { OAuth2Client } from "google-auth-library";
import { docsApi, driveApi } from "@/lib/google/docs";
import { docPlainText } from "./doc-text";

// Reads one picked protocol with the admin's own Google grant (drive.file: the Picker granted
// exactly the picked files). The text goes to the extraction call only; never stored or logged.

export async function readProtocolDoc(auth: OAuth2Client, documentId: string): Promise<{ title: string; text: string }> {
  const doc = (await docsApi(auth).documents.get({ documentId, includeTabsContent: true })).data;
  return { title: (doc.title ?? "").trim(), text: docPlainText(doc) };
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
