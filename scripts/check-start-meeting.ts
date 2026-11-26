/**
 * Early check for createMeetingDoc against real Google: creates one meeting Doc in the user's
 * Drive and verifies folder, tabs, named ranges, header text and the (silent) share.
 *
 *   npm run check-start-meeting -- <userId|email> [memberEmail ...]
 *
 * Deletes nothing in Drive.
 */
import { randomUUID } from "node:crypto";
import { authFor, errInfo, prepareEnv } from "./lib/google-env";

async function main() {
  const [userArg, ...members] = process.argv.slice(2);
  if (!userArg) throw new Error("usage: npm run check-start-meeting -- <userId|email> [memberEmail ...]");
  await prepareEnv();
  const { createMeetingDoc } = await import("@/lib/docs/create");
  const { docsApi, driveApi, readTab } = await import("@/lib/google/docs");
  const { auth } = await authFor(userArg);
  const meetingId = randomUUID();

  const created = await createMeetingDoc(auth, {
    meetingId,
    orgName: "Simon Says test",
    startedAt: new Date(),
    title: `Simon Says test ${new Date().toISOString()}`,
    memberEmails: members,
    shareTranscript: true,
  });
  console.log("created:", JSON.stringify(created, null, 2));
  console.log(`https://docs.google.com/document/d/${created.docId}/edit`);

  const ok = (name: string, pass: boolean, extra = "") => console.log(`${pass ? "OK  " : "FAIL"} ${name}${extra ? `: ${extra}` : ""}`);
  const drive = driveApi(auth);
  const file = (await drive.files.get({ fileId: created.docId, fields: "name,parents,owners(emailAddress)" })).data;
  const folder = (await drive.files.get({ fileId: file.parents![0], fields: "name,mimeType" })).data;
  ok("Doc in folder 'Simon Says – Simon Says test'", folder.name === "Simon Says – Simon Says test", `${folder.name}; doc "${file.name}"`);

  const doc = (await docsApi(auth).documents.get({ documentId: created.docId, includeTabsContent: true })).data;
  const titles = (doc.tabs ?? []).map((t) => t.tabProperties?.title);
  ok("tabs Anteckningar + Transkript", titles.join("|") === "Anteckningar|Transkript", titles.join(", "));
  ok("transcript tab id matches", doc.tabs?.[1]?.tabProperties?.tabId === created.transcriptTabId);

  const notes = readTab(doc, created.notesTabId);
  const header = notes.ranges.find((r) => r.name === created.headerRange);
  ok("header range text == header_rendered", header?.parts[0]?.text === created.headerRendered, header?.parts[0]?.text);
  for (const [section, name] of Object.entries(created.sectionRanges)) {
    const r = notes.ranges.find((x) => x.name === name);
    ok(`section range ${section}`, !!r?.parts[0]?.text, r?.parts[0]?.text);
  }
  const headings = (doc.tabs?.[0]?.documentTab?.body?.content ?? [])
    .filter((e) => e.paragraph?.paragraphStyle?.namedStyleType === "HEADING_3")
    .map((e) => e.paragraph?.elements?.[0]?.textRun?.content?.trim());
  ok("four HEADING_3", headings.length === 4, headings.join(", "));

  const folders = (await drive.files.list({ q: "name='Simon Says – Simon Says test' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'me' in owners", fields: "files(id)" })).data.files ?? [];
  ok("exactly one org folder (reused on later runs)", folders.length === 1, String(folders.length));

  // appendTranscript: the empty tab, then again after "a person typed" on the last line.
  const { appendTranscript } = await import("@/lib/docs/transcript");
  const tab = created.transcriptTabId!;
  await appendTranscript(auth, created.docId, tab, [{ speaker: "Anna", atMs: 2_512_000, text: "Första raden." }]);
  await docsApi(auth).documents.batchUpdate({ documentId: created.docId, requestBody: { requests: [{ insertText: { text: "jag skriver här", endOfSegmentLocation: { tabId: tab } } }] } });
  await appendTranscript(auth, created.docId, tab, [{ speaker: "Erik", atMs: 2_518_000, text: "Andra raden." }]);
  const after = readTab((await docsApi(auth).documents.get({ documentId: created.docId, includeTabsContent: true })).data, tab).text;
  ok("transcript appended without gluing onto typed text", after === "Anna 00:41:52: Första raden.\njag skriver här\nErik 00:41:58: Andra raden.\n\n", JSON.stringify(after));

  const perms = (await drive.permissions.list({ fileId: created.docId, fields: "permissions(emailAddress,role,type)" })).data.permissions ?? [];
  console.log("permissions:", JSON.stringify(perms));
  for (const m of members) ok(`shared writer with ${m}`, perms.some((p) => p.emailAddress?.toLowerCase() === m.toLowerCase() && p.role === "writer"));
}

main().catch((err) => {
  console.error("check-start-meeting failed:", errInfo(err));
  process.exit(1);
});
