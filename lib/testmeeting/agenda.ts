import "server-only";
import type { OAuth2Client } from "google-auth-library";
import agenda from "@/fixtures/agenda/veckomote.agenda.json";
import { findOrCreateFolder, folderName } from "@/lib/docs/create";
import { skeletonRequests, skeletonTableFill } from "@/lib/docs/skeleton";
import { parseNotesTab } from "@/lib/docs/tab";
import { skeletonBlocks, type SkeletonItem } from "@/lib/formats/skeleton";
import { VECKOMOTE } from "@/lib/formats/standard";
import { docsApi, driveApi, type DocsRequest } from "@/lib/google/docs";
import { supabaseAdmin } from "@/lib/supabase/admin";

// "Testmöte med dagordning" (A13): a fictional Veckomöte agenda Doc (Ekdala Padelklubb, invented
// people), as a förening would have prepared it, for a test meeting in agenda mode.

const DOC_MIME = "application/vnd.google-apps.document";

/** The agenda fixture: the six items (two prepared sub-bullets under "Kommande event") and the Sekreterare. */
export const TEST_AGENDA: { sekreterare: string; items: SkeletonItem[] } = agenda;

/** `YYYY-MM-DD` in Swedish local time. */
function localDate(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The org meeting folder when this grant can add files to it (drive.file: only if the user picked it), else null. */
async function writableFolder(auth: OAuth2Client, folderId: string): Promise<string | null> {
  try {
    const res = await driveApi(auth).files.get({ fileId: folderId, fields: "capabilities(canAddChildren)", supportsAllDrives: true });
    return res.data.capabilities?.canAddChildren ? folderId : null;
  } catch (err) {
    // Not visible to this grant (404/403) or any other error: the starter's own folder is fine for a test.
    console.warn(`test agenda doc: meeting folder not usable: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A new Doc `Mötesprotokoll <YYYY-MM-DD> (Testmöte)` holding the Veckomöte skeleton with the
 * fixture's items and Sekreterare filled in: in the org meeting folder when the starter's grant
 * can write there, else in the starter's "Simon Says – <org>" folder. Never shared (a test).
 * Two batches as createFormatDoc: the text and empty table, then the cells from a fresh read.
 */
export async function createTestAgendaDoc(
  auth: OAuth2Client,
  opts: { orgName: string; folderId: string | null; startedAt: Date },
): Promise<{ docId: string }> {
  const drive = driveApi(auth);
  const docs = docsApi(auth);
  const parent =
    (opts.folderId ? await writableFolder(auth, opts.folderId) : null) ?? (await findOrCreateFolder(auth, folderName(opts.orgName)));
  const docId = (
    await drive.files.create({
      requestBody: { name: `${VECKOMOTE.title} ${localDate(opts.startedAt)} (Testmöte)`, mimeType: DOC_MIME, parents: [parent], writersCanShare: false },
      fields: "id",
      supportsAllDrives: true,
    })
  ).data.id;
  if (!docId) throw new Error("createTestAgendaDoc: Doc has no id");
  const first = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const tabId = first.tabs?.[0]?.tabProperties?.tabId;
  if (!tabId) throw new Error("createTestAgendaDoc: new Doc has no tab");

  const blocks = skeletonBlocks(VECKOMOTE, { items: TEST_AGENDA.items, filled: { Sekreterare: TEST_AGENDA.sekreterare } });
  const requests: DocsRequest[] = [
    { updateDocumentTabProperties: { tabProperties: { tabId, title: VECKOMOTE.title }, fields: "title" } },
    ...skeletonRequests(tabId, blocks, VECKOMOTE.numbering),
  ];
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  const doc = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const fill = skeletonTableFill(parseNotesTab(doc, tabId), blocks);
  if (fill.length) await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: fill } });
  return { docId };
}

/** Best effort after a refused start: the unused test Doc goes to the trash (we created it, drive.file may). */
export async function trashTestDoc(auth: OAuth2Client, docId: string): Promise<void> {
  await driveApi(auth).files.update({ fileId: docId, requestBody: { trashed: true }, supportsAllDrives: true });
}

/** Which fixture week to replay: "b" once the org has a finished agenda Testmöte (its tasks are carried), else "a". */
export async function testRun(orgId: string): Promise<"a" | "b"> {
  const { data, error } = await supabaseAdmin()
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "done")
    .eq("is_test", true)
    .eq("layout", "format")
    .eq("agenda_doc", true)
    .limit(1);
  if (error) throw new Error(`testRun: ${error.message}`);
  return (data ?? []).length > 0 ? "b" : "a";
}
