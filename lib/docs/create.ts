import type { OAuth2Client } from "google-auth-library";
import type { NoteSection } from "@/lib/db/types";
import type { FormatProfile } from "@/lib/formats/schema";
import { skeletonBlocks, type SkeletonBlock } from "@/lib/formats/skeleton";
import { docsApi, driveApi, paragraphsWithRanges, type DocsRequest } from "@/lib/google/docs";
import { MEETING_DOC_TAG, TEST_DOC_SUFFIX } from "@/lib/agenda/candidates";
import { skeletonRequests, skeletonTableFill } from "./skeleton";
import { parseNotesTab } from "./tab";

/** Section headings of the notes tab, in order. */
export const SECTIONS: { section: NoteSection; title: string }[] = [
  { section: "attendees", title: "Närvarande" },
  { section: "decision", title: "Beslut" },
  { section: "action", title: "Att göra" },
  { section: "now", title: "Pågår nu" },
];

/** The header line a new Doc starts with; stored as meetings.header_rendered. */
export const INITIAL_HEADER = "LIVE · uppdaterad –";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

export interface CreateMeetingDocInput {
  /** Becomes meetings.id; the named ranges are `ss-<meetingId>-…`. */
  meetingId: string;
  orgName: string;
  startedAt: Date;
  /** The Doc's file name (`meetingTitle`). */
  title: string;
  /** The förening's meeting folder (orgs.meeting_folder_id): the Doc goes there when this grant can add to it. */
  meetingFolderId?: string | null;
  /** Emails to share the Doc with as writers (not the starter, who owns it). */
  memberEmails: string[];
  /** Whether the transcript tab is added (the transcript is stored in the database either way). */
  shareTranscript: boolean;
}

/**
 * Where a new Doc went: the förening's meeting folder, or the starter's own folder "Simon Says –
 * <förening>" (no meeting folder, or this starter's grant can't add to it: drive.file only sees a
 * folder this user picked in the Picker).
 */
export type DocPlace = "meeting_folder" | "own_folder";

export interface MeetingDoc {
  docId: string;
  notesTabId: string;
  transcriptTabId: string | null;
  headerRange: string;
  /** The exact header text written (store as header_rendered). */
  headerRendered: string;
  sectionRanges: Record<NoteSection, string>;
  place: DocPlace;
  /** Emails the Doc was shared with (writer). */
  shared: string[];
  /** Emails the Doc could not be shared with (the meeting still works). */
  shareFailed: string[];
}

/** `YYYY-MM-DD` in Swedish local time. */
export function localDate(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** `HH.MM` in Swedish local time (a dot: Drive names stay readable, and it sorts). */
function localTime(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(at)
    .replace(":", ".");
}

/**
 * The file name of a meeting Doc: `2026-11-26 18.05 Mötesprotokoll – <Förening>`. Date and
 * start time first, so the meeting folder sorts chronologically by name and two meetings the same
 * day never share a name; always "Mötesprotokoll" (every format); the förening's name, so the Doc
 * is recognisable under "Delas med mig". A Testmöte ends with TEST_DOC_SUFFIX (listCandidates
 * never offers it as an agenda). A meeting that matched a calendar event (todo #14) carries the
 * event's title before the förening's name (cleaned by the caller: one line).
 */
export function meetingTitle(orgName: string, startedAt: Date, opts: { test?: boolean; eventTitle?: string | null } = {}): string {
  const event = opts.eventTitle?.trim() ? `${opts.eventTitle.trim()} – ` : "";
  return `${localDate(startedAt)} ${localTime(startedAt)} Mötesprotokoll – ${event}${orgName.trim()}${opts.test ? ` ${TEST_DOC_SUFFIX}` : ""}`;
}

/** The starter's own folder for the org's Docs. */
export const folderName = (orgName: string) => `Simon Says – ${orgName}`;
const escapeQuery = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** The starter's folder for the org: an existing one the app made (drive.file only sees those), or a new one. */
export async function findOrCreateFolder(auth: OAuth2Client, name: string): Promise<string> {
  const drive = driveApi(auth);
  const found = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and name='${escapeQuery(name)}' and trashed=false and 'me' in owners`,
    fields: "files(id)",
    pageSize: 1,
    spaces: "drive",
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) return existing;
  const created = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME }, fields: "id" });
  if (!created.data.id) throw new Error("createMeetingDoc: folder has no id");
  return created.data.id;
}

/**
 * The meeting folder when this grant can add files to it (drive.file: only a folder this user
 * picked in the Picker, or one the app created), else null. `sharedDrive`: the folder is in a
 * shared drive (no writersCanShare there). Any error (404/403 for a folder never picked) is null.
 */
export async function writableFolder(auth: OAuth2Client, folderId: string): Promise<{ id: string; sharedDrive: boolean } | null> {
  try {
    const res = await driveApi(auth).files.get({ fileId: folderId, fields: "driveId,capabilities(canAddChildren)", supportsAllDrives: true });
    return res.data.capabilities?.canAddChildren ? { id: folderId, sharedDrive: Boolean(res.data.driveId) } : null;
  } catch (err) {
    console.warn(`meeting folder not usable: ${(err as Error).message}`);
    return null;
  }
}


/**
 * A new Doc named `title`, in the meeting folder when this grant can add to it, else in the
 * starter's own org folder (also when the create in the meeting folder fails: placement never
 * fails a start). Members can edit but not share further (writersCanShare=false; not in a shared
 * drive, where the drive's own settings decide). Its first tab id.
 */
async function createDocFile(
  auth: OAuth2Client,
  input: Pick<CreateMeetingDocInput, "orgName" | "title" | "meetingFolderId">,
): Promise<{ docId: string; tabId: string; place: DocPlace }> {
  const drive = driveApi(auth);
  const create = async (parent: string, sharedDrive: boolean) =>
    (
      await drive.files.create({
        requestBody: {
          name: input.title,
          mimeType: DOC_MIME,
          parents: [parent],
          appProperties: { ...MEETING_DOC_TAG },
          ...(sharedDrive ? {} : { writersCanShare: false }),
        },
        fields: "id",
        supportsAllDrives: true,
      })
    ).data.id;

  let docId: string | null | undefined = null;
  let place: DocPlace = "own_folder";
  const folder = input.meetingFolderId ? await writableFolder(auth, input.meetingFolderId) : null;
  if (folder) {
    try {
      docId = await create(folder.id, folder.sharedDrive);
      place = "meeting_folder";
    } catch (err) {
      console.warn(`createMeetingDoc: create in meeting folder failed, using own folder: ${(err as Error).message}`);
    }
  }
  if (!docId) {
    docId = await create(await findOrCreateFolder(auth, folderName(input.orgName)), false);
    place = "own_folder";
  }
  if (!docId) throw new Error("createMeetingDoc: Doc has no id");
  const first = (await docsApi(auth).documents.get({ documentId: docId, includeTabsContent: true })).data;
  const tabId = first.tabs?.[0]?.tabProperties?.tabId;
  if (!tabId) throw new Error("createMeetingDoc: new Doc has no tab");
  return { docId, tabId, place };
}

/** Writer access for one address, no notification email. Throws on failure. */
export async function shareWith(auth: OAuth2Client, docId: string, emailAddress: string): Promise<void> {
  await driveApi(auth).permissions.create({
    fileId: docId,
    sendNotificationEmail: false,
    supportsAllDrives: true,
    requestBody: { role: "writer", type: "user", emailAddress },
  });
}

/**
 * Takes one address's access away (Företag, 0050: they can no longer see the meeting). Idempotent:
 * no permission for the address is a success. Throws on a Drive failure.
 */
export async function unshareWith(auth: OAuth2Client, docId: string, emailAddress: string): Promise<boolean> {
  const drive = driveApi(auth);
  const list = await drive.permissions.list({ fileId: docId, supportsAllDrives: true, fields: "permissions(id,emailAddress,role)" });
  const target = emailAddress.trim().toLowerCase();
  const hits = (list.data.permissions ?? []).filter((p) => (p.emailAddress ?? "").toLowerCase() === target && p.role !== "owner");
  for (const p of hits) await drive.permissions.delete({ fileId: docId, permissionId: p.id!, supportsAllDrives: true });
  return hits.length > 0;
}

/** Writer access for each member, no notification email; the addresses that worked and that failed. */
async function shareDoc(auth: OAuth2Client, docId: string, memberEmails: string[]): Promise<{ shared: string[]; shareFailed: string[] }> {
  // One failing address (e.g. not a Google account) must not stop the meeting.
  const shared: string[] = [];
  const shareFailed: string[] = [];
  for (const emailAddress of memberEmails) {
    try {
      await shareWith(auth, docId, emailAddress);
      shared.push(emailAddress);
    } catch (err) {
      console.error(`createMeetingDoc: share failed: ${(err as Error).message}`);
      shareFailed.push(emailAddress);
    }
  }
  return { shared, shareFailed };
}

/** Best effort after a refused start: the unused new Doc goes to the trash (we created it, drive.file may). */
export async function trashDoc(auth: OAuth2Client, docId: string): Promise<void> {
  await driveApi(auth).files.update({ fileId: docId, requestBody: { trashed: true }, supportsAllDrives: true });
}

const TRANSCRIPT_TAB: DocsRequest = { addDocumentTab: { tabProperties: { title: "Transkript" } } };

/** Agenda mode with "Lägg transkriptet i dokumentet?" = ja: a "Transkript" tab in the förening's own Doc; its id. */
export async function addTranscriptTab(auth: OAuth2Client, docId: string): Promise<string> {
  const res = await docsApi(auth).documents.batchUpdate({ documentId: docId, requestBody: { requests: [TRANSCRIPT_TAB] } });
  const tabId = res.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
  if (!tabId) throw new Error("addTranscriptTab: transcript tab was not created");
  return tabId;
}

/**
 * Create the meeting's Google Doc (in the meeting folder or the starter's org folder, see createDocFile): a notes tab
 * ("Anteckningar": header line + four section headings, each with a named range), a "Transkript"
 * tab if `shareTranscript`, and writer access for the members (no notification email).
 */
export async function createMeetingDoc(auth: OAuth2Client, input: CreateMeetingDocInput): Promise<MeetingDoc> {
  const { meetingId, memberEmails, shareTranscript } = input;
  const docs = docsApi(auth);
  const { docId, tabId: notesTabId, place } = await createDocFile(auth, input);

  const headerRange = `ss-${meetingId}-header`;
  const sectionRanges = Object.fromEntries(
    SECTIONS.map((s) => [s.section, `ss-${meetingId}-sec-${s.section}`]),
  ) as Record<NoteSection, string>;
  const paragraphs = [
    { name: headerRange, text: INITIAL_HEADER },
    ...SECTIONS.map((s) => ({ name: sectionRanges[s.section], text: s.title })),
  ];
  const requests: DocsRequest[] = [
    { updateDocumentTabProperties: { tabProperties: { tabId: notesTabId, title: "Anteckningar" }, fields: "title" } },
    ...paragraphsWithRanges(notesTabId, 1, paragraphs),
  ];
  let at = 1 + INITIAL_HEADER.length + 1;
  for (const s of SECTIONS) {
    requests.push({
      updateParagraphStyle: {
        range: { tabId: notesTabId, startIndex: at, endIndex: at + s.title.length },
        paragraphStyle: { namedStyleType: "HEADING_3" },
        fields: "namedStyleType",
      },
    });
    at += s.title.length + 1;
  }
  if (shareTranscript) requests.push(TRANSCRIPT_TAB);

  const res = await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  const transcriptTabId = shareTranscript
    ? (res.data.replies?.at(-1)?.addDocumentTab?.tabProperties?.tabId ?? null)
    : null;
  if (shareTranscript && !transcriptTabId) throw new Error("createMeetingDoc: transcript tab was not created");

  const { shared, shareFailed } = await shareDoc(auth, docId, memberEmails);
  return { docId, notesTabId, transcriptTabId, headerRange, headerRendered: INITIAL_HEADER, sectionRanges, place, shared, shareFailed };
}

/**
 * The fallback / Testmöte Doc in a format (spec G8): same folder, title, sharing and transcript
 * tab rules as createMeetingDoc; the notes tab (named after the profile's title) holds
 * `skeletonBlocks(profile)`, or `blocks` (A13 passes its own items and filled values). Two batches:
 * the text and empty table, then the table cells from a fresh read (A1 M6). No named ranges:
 * anchorAgenda anchors the new Doc like any agenda Doc. Enkel never comes here (v1 Doc).
 */
export async function createFormatDoc(
  auth: OAuth2Client,
  input: CreateMeetingDocInput & { profile: FormatProfile; blocks?: SkeletonBlock[] },
): Promise<{ docId: string; tabId: string; transcriptTabId: string | null; place: DocPlace; shared: string[]; shareFailed: string[] }> {
  const { memberEmails, shareTranscript, profile } = input;
  const docs = docsApi(auth);
  const { docId, tabId, place } = await createDocFile(auth, input);
  const blocks = input.blocks ?? skeletonBlocks(profile);

  const requests: DocsRequest[] = [
    { updateDocumentTabProperties: { tabProperties: { tabId, title: profile.title }, fields: "title" } },
    ...skeletonRequests(tabId, blocks, profile.numbering),
  ];
  if (shareTranscript) requests.push(TRANSCRIPT_TAB);
  const res = await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  const transcriptTabId = shareTranscript
    ? (res.data.replies?.at(-1)?.addDocumentTab?.tabProperties?.tabId ?? null)
    : null;
  if (shareTranscript && !transcriptTabId) throw new Error("createFormatDoc: transcript tab was not created");

  if (blocks.some((b) => b.type === "table")) {
    const doc = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
    const fill = skeletonTableFill(parseNotesTab(doc, tabId), blocks);
    if (fill.length) await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: fill } });
  }

  const { shared, shareFailed } = await shareDoc(auth, docId, memberEmails);
  return { docId, tabId, transcriptTabId, place, shared, shareFailed };
}
