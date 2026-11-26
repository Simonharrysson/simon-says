import "server-only";
import type { OAuth2Client } from "google-auth-library";
import agenda from "@/fixtures/agenda/veckomote.agenda.json";
import { findOrCreateFolder, folderName, meetingTitle, trashDoc, writableFolder } from "@/lib/docs/create";
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

/**
 * A new Doc `<YYYY-MM-DD> Mötesprotokoll – <förening> (Testmöte)` (meetingTitle) holding the Veckomöte skeleton with the
 * fixture's items and Sekreterare filled in: in the org meeting folder when the starter's grant
 * can write there, else in the starter's "Simon Says – <org>" folder. We add no permissions, but
 * a Doc in the org meeting folder inherits the folder's sharing, so members can see it (it is
 * fictional). Its title ends with TEST_DOC_SUFFIX, so listCandidates never offers it. Two
 * batches as createFormatDoc: the text and empty table, then the cells from a fresh read. If any
 * step after the create fails, the new file is trashed (best effort) and the error rethrown.
 */
export async function createTestAgendaDoc(
  auth: OAuth2Client,
  opts: { orgName: string; folderId: string | null; startedAt: Date },
): Promise<{ docId: string }> {
  const drive = driveApi(auth);
  const folder = opts.folderId ? await writableFolder(auth, opts.folderId) : null;
  const parent = folder?.id ?? (await findOrCreateFolder(auth, folderName(opts.orgName)));
  const docId = (
    await drive.files.create({
      requestBody: {
        name: meetingTitle(opts.orgName, opts.startedAt, { formatTitle: VECKOMOTE.title, test: true }),
        mimeType: DOC_MIME,
        parents: [parent],
        ...(folder?.sharedDrive ? {} : { writersCanShare: false }),
      },
      fields: "id",
      supportsAllDrives: true,
    })
  ).data.id;
  if (!docId) throw new Error("createTestAgendaDoc: Doc has no id");
  try {
    await writeTestAgenda(auth, docId);
  } catch (err) {
    await trashTestDoc(auth, docId).catch((e: Error) => console.error(`createTestAgendaDoc: trash after failure: ${e.message}`));
    throw err;
  }
  return { docId };
}

/** The skeleton into the new Doc's first tab, then the table cells from a fresh read. */
async function writeTestAgenda(auth: OAuth2Client, docId: string): Promise<void> {
  const docs = docsApi(auth);
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
}

/** Best effort after a refused start: the unused test Doc goes to the trash (we created it, drive.file may). */
export const trashTestDoc = trashDoc;

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
