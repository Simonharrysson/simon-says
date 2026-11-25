import type { OAuth2Client } from "google-auth-library";
import type { NoteSection } from "@/lib/db/types";
import { docsApi, driveApi, paragraphsWithRanges, type DocsRequest } from "@/lib/google/docs";

/** Section headings of the notes tab, in order. */
export const SECTIONS: { section: NoteSection; title: string }[] = [
  { section: "attendees", title: "Närvarande" },
  { section: "decision", title: "Beslut" },
  { section: "action", title: "Att göra" },
  { section: "now", title: "Pågår nu" },
];

/** The header line a new Doc starts with; stored as meetings.header_rendered. */
export const INITIAL_HEADER = "● LIVE · uppdaterad –";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

export interface CreateMeetingDocInput {
  /** Becomes meetings.id; the named ranges are `ss-<meetingId>-…`. */
  meetingId: string;
  orgName: string;
  startedAt: Date;
  /** Emails to share the Doc with as writers (not the starter, who owns it). */
  memberEmails: string[];
  /** Whether the transcript tab is added (the transcript is stored in the database either way). */
  shareTranscript: boolean;
}

export interface MeetingDoc {
  docId: string;
  notesTabId: string;
  transcriptTabId: string | null;
  headerRange: string;
  /** The exact header text written (store as header_rendered). */
  headerRendered: string;
  sectionRanges: Record<NoteSection, string>;
  /** Emails the Doc could not be shared with (the meeting still works). */
  shareFailed: string[];
}

/** `<Org> möte 2026-11-24 14:05`, in Swedish local time. */
export function meetingTitle(orgName: string, startedAt: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(startedAt)
      .map((p) => [p.type, p.value]),
  );
  return `${orgName} möte ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const folderName = (orgName: string) => `Simon Says – ${orgName}`;
const escapeQuery = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** The starter's folder for the org: an existing one the app made (drive.file only sees those), or a new one. */
async function findOrCreateFolder(auth: OAuth2Client, name: string): Promise<string> {
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
 * Create the meeting's Google Doc in the starter's Drive: in the org folder, a notes tab
 * ("Anteckningar": header line + four section headings, each with a named range), a "Transkript"
 * tab if `shareTranscript`, and writer access for the members (no notification email).
 */
export async function createMeetingDoc(auth: OAuth2Client, input: CreateMeetingDocInput): Promise<MeetingDoc> {
  const { meetingId, orgName, startedAt, memberEmails, shareTranscript } = input;
  const drive = driveApi(auth);
  const docs = docsApi(auth);

  const folderId = await findOrCreateFolder(auth, folderName(orgName));
  const docId = (
    await drive.files.create({
      // writersCanShare=false: members get edit access, but only the owner can share it further.
      requestBody: { name: meetingTitle(orgName, startedAt), mimeType: DOC_MIME, parents: [folderId], writersCanShare: false },
      fields: "id",
    })
  ).data.id;
  if (!docId) throw new Error("createMeetingDoc: Doc has no id");

  const first = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const notesTabId = first.tabs?.[0]?.tabProperties?.tabId;
  if (!notesTabId) throw new Error("createMeetingDoc: new Doc has no tab");

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
  if (shareTranscript) requests.push({ addDocumentTab: { tabProperties: { title: "Transkript" } } });

  const res = await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  const transcriptTabId = shareTranscript
    ? (res.data.replies?.at(-1)?.addDocumentTab?.tabProperties?.tabId ?? null)
    : null;
  if (shareTranscript && !transcriptTabId) throw new Error("createMeetingDoc: transcript tab was not created");

  // One failing address (e.g. not a Google account) must not stop the meeting.
  const shareFailed: string[] = [];
  for (const emailAddress of memberEmails) {
    try {
      await drive.permissions.create({
        fileId: docId,
        sendNotificationEmail: false,
        requestBody: { role: "writer", type: "user", emailAddress },
      });
    } catch (err) {
      console.error(`createMeetingDoc: share failed: ${(err as Error).message}`);
      shareFailed.push(emailAddress);
    }
  }

  return { docId, notesTabId, transcriptTabId, headerRange, headerRendered: INITIAL_HEADER, sectionRanges, shareFailed };
}
