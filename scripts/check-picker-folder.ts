/**
 * A11 Step 6 early check: does a folder picked in the Google Picker list its children under
 * drive.file, with the user's stored token?
 *
 *   npm run check-picker-folder -- <userId|email> <folderId> [docId]
 *
 * 1. files.get(folder)  — can this grant see the folder at all?
 * 2. files.list("'<folderId>' in parents", Docs, not trashed) — how many children are listed?
 * 3. With [docId] (a Doc picked inside that folder): files.get capabilities and documents.get,
 *    i.e. is it readable and (canEdit) editable by the same token. No write is made.
 *
 * Prints counts, ids, mime types and HTTP statuses only: never file names or Doc text.
 * Env as scripts/check-google.ts (~/simon-says-private/.env).
 */
import { authFor, errInfo, prepareEnv } from "./lib/google-env";

async function main(): Promise<void> {
  const [userArg, folderId, docId] = process.argv.slice(2);
  if (!userArg || !folderId) {
    console.error("usage: npm run check-picker-folder -- <userId|email> <folderId> [docId]");
    process.exit(2);
  }
  await prepareEnv();
  const g = await import("@/lib/google/docs");
  const { userId, auth } = await authFor(userArg);
  console.log(`user ${userId}`);
  const drive = g.driveApi(auth);

  try {
    const f = (await drive.files.get({ fileId: folderId, fields: "id,mimeType", supportsAllDrives: true })).data;
    console.log(`folder: visible (mimeType ${f.mimeType})`);
  } catch (err) {
    console.log("folder: NOT visible", errInfo(err));
  }

  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: "files(id,createdTime,modifiedTime)",
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = res.data.files ?? [];
    console.log(`children listed: ${files.length}`);
    for (const f of files) console.log(`  ${f.id}  created ${f.createdTime}  modified ${f.modifiedTime}`);
  } catch (err) {
    console.log("children: list failed", errInfo(err));
  }

  if (docId) {
    try {
      const d = (await drive.files.get({ fileId: docId, fields: "id,mimeType,parents,capabilities(canEdit)", supportsAllDrives: true })).data;
      console.log(`doc: visible; in folder ${d.parents?.includes(folderId) ? "yes" : "no"}; canEdit ${d.capabilities?.canEdit === true}`);
    } catch (err) {
      console.log("doc: NOT visible", errInfo(err));
    }
    try {
      const doc = (await g.docsApi(auth).documents.get({ documentId: docId, includeTabsContent: true })).data;
      console.log(`doc: documents.get ok (${doc.tabs?.length ?? 0} tabs, revision ${doc.revisionId ? "present" : "missing"})`);
    } catch (err) {
      console.log("doc: documents.get failed", errInfo(err));
    }
  }
}

main().catch((err) => {
  console.error("check-picker-folder failed:", errInfo(err));
  process.exit(1);
});
