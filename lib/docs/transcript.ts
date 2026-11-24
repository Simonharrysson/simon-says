import type { OAuth2Client } from "google-auth-library";
import { appendToTab, docsApi, readTab } from "@/lib/google/docs";

export interface TranscriptLine {
  speaker: string;
  atMs: number;
  text: string;
}

/** HH:MM:SS of a time into the meeting (milliseconds are dropped). */
export function formatTimestamp(atMs: number): string {
  const s = Math.max(0, Math.floor(atMs / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** `Anna 00:41:52: text`, always on one line. */
export function formatLine(line: TranscriptLine): string {
  return `${line.speaker} ${formatTimestamp(line.atMs)}: ${line.text.replace(/\s*\n\s*/g, " ").trim()}`;
}

/**
 * Append lines to the end of the transcript tab with one batchUpdate. The tab is read first:
 * if its last paragraph is not empty (a person is typing there) the text starts with a newline,
 * otherwise our first line would be glued onto theirs (learnings, Task 2).
 */
export async function appendTranscript(
  auth: OAuth2Client,
  docId: string,
  tabId: string,
  lines: TranscriptLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const docs = docsApi(auth);
  const doc = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  // The tab text always ends with the final paragraph's newline; the last paragraph is empty
  // when the text is just that newline or ends with a blank line.
  const { text: existing } = readTab(doc, tabId);
  const lastParagraphEmpty = existing === "" || existing === "\n" || existing.endsWith("\n\n");
  const text = (lastParagraphEmpty ? "" : "\n") + lines.map(formatLine).join("\n") + "\n";
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [appendToTab(tabId, text)] } });
}
