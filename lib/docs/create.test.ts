import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  list: vi.fn(),
  filesCreate: vi.fn(),
  permCreate: vi.fn(),
  permList: vi.fn(),
  permDelete: vi.fn(),
  filesGet: vi.fn(),
  get: vi.fn(),
  batchUpdate: vi.fn(),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: g.get, batchUpdate: g.batchUpdate } }),
  driveApi: () => ({ files: { list: g.list, create: g.filesCreate, get: g.filesGet }, permissions: { create: g.permCreate, list: g.permList, delete: g.permDelete } }),
}));

import { TEST_DOC_SUFFIX } from "@/lib/agenda/candidates";
import { createMeetingDoc, INITIAL_HEADER, meetingTitle, revokeLegacyShare, revokePermission, shareWith } from "./create";

const auth = {} as OAuth2Client;
const M = "11111111-2222-3333-4444-555555555555";
const input = {
  meetingId: M,
  orgName: "LiU AI Society",
  startedAt: new Date("2026-11-24T13:05:00Z"),
  title: "2026-11-24 Möte – LiU AI Society",
  memberEmails: ["a@x.se", "b@x.se"],
  shareTranscript: true,
};

beforeEach(() => {
  Object.values(g).forEach((f) => f.mockReset());
  g.list.mockResolvedValue({ data: { files: [{ id: "folder1" }] } });
  g.filesCreate.mockResolvedValue({ data: { id: "doc1" } });
  g.get.mockResolvedValue({ data: { tabs: [{ tabProperties: { tabId: "t.0" } }] } });
  g.batchUpdate.mockResolvedValue({ data: { replies: [{}, {}, {}, {}, {}, { addDocumentTab: { tabProperties: { tabId: "t.1" } } }] } });
  g.permCreate.mockResolvedValue({ data: {} });
});

describe("meetingTitle", () => {
  it("is date and start time first in Swedish local time (CET in winter, CEST in summer), always Mötesprotokoll", () => {
    expect(meetingTitle("Styrelsen", new Date("2026-11-24T13:05:00Z"))).toBe("2026-11-24 14.05 Mötesprotokoll – Styrelsen");
    expect(meetingTitle("Styrelsen", new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02 00.30 Mötesprotokoll – Styrelsen");
  });

  it("two meetings the same day get different names that sort by start", () => {
    const a = meetingTitle("Ekdala Padelklubb", new Date("2026-11-26T08:00:00Z"));
    const b = meetingTitle("Ekdala Padelklubb", new Date("2026-11-26T18:30:00Z"));
    expect(a).not.toBe(b);
    expect([b, a].sort()).toEqual([a, b]);
  });

  it("marks a Testmöte so it is never an agenda candidate", () => {
    const t = meetingTitle("Ekdala Padelklubb", new Date("2026-11-26T18:00:00Z"), { test: true });
    expect(t).toBe("2026-11-26 19.00 Mötesprotokoll – Ekdala Padelklubb (Testmöte)");
    expect(t.endsWith(TEST_DOC_SUFFIX)).toBe(true);
  });
});

describe("createMeetingDoc placement", () => {
  it("creates the Doc in the meeting folder when this grant can add to it, tagged, not in the own folder", async () => {
    g.filesGet.mockResolvedValue({ data: { capabilities: { canAddChildren: true } } });
    const r = await createMeetingDoc(auth, { ...input, meetingFolderId: "meetFolder" });
    expect(g.filesGet.mock.calls[0][0]).toMatchObject({ fileId: "meetFolder", supportsAllDrives: true });
    expect(g.list).not.toHaveBeenCalled();
    expect(g.filesCreate.mock.calls[0][0]).toMatchObject({
      requestBody: { parents: ["meetFolder"], writersCanShare: false, appProperties: { simonSaysMeeting: "1" } },
      supportsAllDrives: true,
    });
    expect(r.place).toBe("meeting_folder");
  });

  it("leaves writersCanShare to the shared drive", async () => {
    g.filesGet.mockResolvedValue({ data: { driveId: "sd1", capabilities: { canAddChildren: true } } });
    await createMeetingDoc(auth, { ...input, meetingFolderId: "meetFolder" });
    expect(g.filesCreate.mock.calls[0][0].requestBody).not.toHaveProperty("writersCanShare");
  });

  it("falls back to the starter's own folder when the grant can't see the folder (never picked)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    g.filesGet.mockRejectedValue(Object.assign(new Error("File not found"), { code: 404 }));
    const r = await createMeetingDoc(auth, { ...input, meetingFolderId: "meetFolder" });
    expect(g.filesCreate.mock.calls[0][0].requestBody.parents).toEqual(["folder1"]);
    expect(r.place).toBe("own_folder");
  });

  it("falls back when the folder is read-only, and when the create there fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    g.filesGet.mockResolvedValue({ data: { capabilities: { canAddChildren: false } } });
    expect((await createMeetingDoc(auth, { ...input, meetingFolderId: "meetFolder" })).place).toBe("own_folder");

    g.filesCreate.mockReset().mockRejectedValueOnce(new Error("insufficientFilePermissions")).mockResolvedValue({ data: { id: "doc2" } });
    g.filesGet.mockResolvedValue({ data: { capabilities: { canAddChildren: true } } });
    const r = await createMeetingDoc(auth, { ...input, meetingFolderId: "meetFolder" });
    expect(g.filesCreate.mock.calls[1][0].requestBody.parents).toEqual(["folder1"]);
    expect(r).toMatchObject({ docId: "doc2", place: "own_folder" });
  });
});

describe("createMeetingDoc", () => {
  it("creates the Doc in the existing org folder with the meeting title", async () => {
    await createMeetingDoc(auth, input);
    expect(g.list.mock.calls[0][0].q).toContain("name='Simon Says – LiU AI Society'");
    expect(g.list.mock.calls[0][0].q).toContain("'me' in owners");
    expect(g.filesCreate).toHaveBeenCalledTimes(1);
    expect(g.filesCreate.mock.calls[0][0].requestBody).toEqual({
      name: "2026-11-24 Möte – LiU AI Society",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder1"],
      appProperties: { simonSaysMeeting: "1" },
      writersCanShare: false, // members edit, only the owner shares further
    });
    expect(g.filesGet).not.toHaveBeenCalled(); // no meeting folder
  });

  it("creates the folder when there is none, and escapes quotes in the name", async () => {
    g.list.mockResolvedValue({ data: { files: [] } });
    g.filesCreate.mockResolvedValueOnce({ data: { id: "newfolder" } }).mockResolvedValueOnce({ data: { id: "doc1" } });
    await createMeetingDoc(auth, { ...input, orgName: "Anna's" });
    expect(g.list.mock.calls[0][0].q).toContain("name='Simon Says – Anna\\'s'");
    expect(g.filesCreate.mock.calls[0][0].requestBody).toMatchObject({
      name: "Simon Says – Anna's",
      mimeType: "application/vnd.google-apps.folder",
    });
    expect(g.filesCreate.mock.calls[1][0].requestBody.parents).toEqual(["newfolder"]);
  });

  it("writes header + four headings with named ranges, all with the tabId", async () => {
    const r = await createMeetingDoc(auth, input);
    const reqs = g.batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(reqs[0]).toEqual({
      updateDocumentTabProperties: { tabProperties: { tabId: "t.0", title: "Anteckningar" }, fields: "title" },
    });
    expect(reqs[1].insertText).toEqual({
      text: `${INITIAL_HEADER}\nNärvarande\nBeslut\nAtt göra\nPågår nu`,
      location: { index: 1, tabId: "t.0" },
    });
    const ranges = reqs.filter((q: { createNamedRange?: unknown }) => q.createNamedRange).map((q: { createNamedRange: { name: string; range: object } }) => q.createNamedRange);
    expect(ranges.map((x: { name: string }) => x.name)).toEqual([
      `ss-${M}-header`,
      `ss-${M}-sec-attendees`,
      `ss-${M}-sec-decision`,
      `ss-${M}-sec-action`,
      `ss-${M}-sec-now`,
    ]);
    const h = INITIAL_HEADER.length;
    expect(ranges[0].range).toEqual({ tabId: "t.0", startIndex: 1, endIndex: 1 + h });
    expect(ranges[1].range).toEqual({ tabId: "t.0", startIndex: 2 + h, endIndex: 2 + h + "Närvarande".length });
    const styles = reqs.filter((q: { updateParagraphStyle?: unknown }) => q.updateParagraphStyle).map((q: { updateParagraphStyle: { range: object; paragraphStyle: object } }) => q.updateParagraphStyle);
    expect(styles).toHaveLength(4);
    expect(styles[0]).toEqual({
      range: { tabId: "t.0", startIndex: 2 + h, endIndex: 2 + h + "Närvarande".length },
      paragraphStyle: { namedStyleType: "HEADING_3" },
      fields: "namedStyleType",
    });
    expect(reqs.at(-1)).toEqual({ addDocumentTab: { tabProperties: { title: "Transkript" } } });
    expect(r).toMatchObject({
      docId: "doc1",
      notesTabId: "t.0",
      transcriptTabId: "t.1",
      headerRange: `ss-${M}-header`,
      headerRendered: INITIAL_HEADER,
      sectionRanges: {
        attendees: `ss-${M}-sec-attendees`,
        decision: `ss-${M}-sec-decision`,
        action: `ss-${M}-sec-action`,
        now: `ss-${M}-sec-now`,
      },
      place: "own_folder",
      shared: ["a@x.se", "b@x.se"],
      shareFailed: [],
      grants: {},
    });
  });

  it("adds no Transkript tab when the transcript is not shared", async () => {
    const r = await createMeetingDoc(auth, { ...input, shareTranscript: false });
    const reqs = g.batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(reqs.some((q: { addDocumentTab?: unknown }) => q.addDocumentTab)).toBe(false);
    expect(r.transcriptTabId).toBeNull();
  });

  it("shares as writer without notification email", async () => {
    await createMeetingDoc(auth, input);
    expect(g.permCreate).toHaveBeenCalledTimes(2);
    for (const [i, email] of ["a@x.se", "b@x.se"].entries()) {
      expect(g.permCreate.mock.calls[i][0]).toEqual({
        fileId: "doc1",
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: { role: "writer", type: "user", emailAddress: email },
      });
    }
  });

  it("reports addresses it could not share with instead of failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.permCreate.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({ data: {} });
    const r = await createMeetingDoc(auth, input);
    expect(r.shareFailed).toEqual(["a@x.se"]);
    expect(r.shared).toEqual(["b@x.se"]);
  });

  it("throws when the Doc cannot be written", async () => {
    g.batchUpdate.mockRejectedValue(new Error("boom"));
    await expect(createMeetingDoc(auth, input)).rejects.toThrow("boom");
    expect(g.permCreate).not.toHaveBeenCalled();
  });
});

describe("createFormatDoc", () => {
  it("same folder, title, transcript tab and sharing as v1; skeleton in batch 1, cells from a fresh read in batch 2", async () => {
    const { apply, docOf, paraEl } = await import("@/test/docsim");
    const { VECKOMOTE } = await import("@/lib/formats/standard");
    const { createFormatDoc } = await import("./create");
    const { parseNotesTab } = await import("./tab");
    const doc = docOf([paraEl("")]);
    g.get.mockImplementation(async () => ({ data: JSON.parse(JSON.stringify(doc)) }));
    g.batchUpdate.mockImplementation(async ({ requestBody }: { requestBody: { requests: Parameters<typeof apply>[1] } }) => {
      apply(doc, requestBody.requests);
      const replies = requestBody.requests.map((r) => (r.addDocumentTab ? { addDocumentTab: { tabProperties: { tabId: "t.1" } } } : {}));
      return { data: { replies } };
    });
    g.permCreate.mockImplementation(async ({ requestBody }: { requestBody: { emailAddress: string } }) => {
      if (requestBody.emailAddress === "b@x.se") throw new Error("not a Google account");
      return { data: {} };
    });
    const res = await createFormatDoc(auth, { ...input, profile: VECKOMOTE });
    expect(res).toEqual({ docId: "doc1", tabId: "t.0", transcriptTabId: "t.1", place: "own_folder", shared: ["a@x.se"], shareFailed: ["b@x.se"], grants: {} });
    expect(g.filesCreate.mock.calls[0][0].requestBody.name).toBe("2026-11-24 Möte – LiU AI Society");
    expect(g.filesCreate.mock.calls[0][0].requestBody.writersCanShare).toBe(false);
    expect(g.get).toHaveBeenCalledTimes(2);
    expect(g.batchUpdate).toHaveBeenCalledTimes(2);
    const first = g.batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(first.at(-1).addDocumentTab).toBeTruthy();
    expect(first.some((r: { insertTable?: unknown }) => r.insertTable)).toBe(true);
    const second = g.batchUpdate.mock.calls[1][0].requestBody.requests;
    expect(second.every((r: { insertText?: unknown }) => r.insertText)).toBe(true);
    const cells = parseNotesTab(doc, "t.0").tables![0].rows.map((r) => r.cells.map((c) => c.text));
    expect(cells).toEqual([["Datum", ""], ["Tid", ""], ["Närvarande", ""], ["Sekreterare", ""]]);
    expect(g.permCreate).toHaveBeenCalledTimes(2);
    expect(g.permCreate.mock.calls[0][0]).toMatchObject({ fileId: "doc1", sendNotificationEmail: false, requestBody: { role: "writer", type: "user" } });
  });
});

describe("only the permission Simon Says created is ours (0053)", () => {
  it("a new share returns the permission id Drive created", async () => {
    g.permCreate.mockResolvedValue({ data: { id: "p1" } });
    expect(await shareWith(auth, "doc1", "a@x.se")).toEqual({ permissionId: "p1", preexisting: false });
    expect(g.permList).not.toHaveBeenCalled();
  });

  it("an address that already has access (shared by hand) is left alone and marked preexisting", async () => {
    g.permList.mockResolvedValue({ data: { permissions: [{ id: "hand", emailAddress: "A@x.se", role: "writer" }] } });
    expect(await shareWith(auth, "doc1", "a@x.se", { checkExisting: true })).toEqual({ permissionId: null, preexisting: true });
    expect(g.permCreate).not.toHaveBeenCalled();
  });

  it("revoking removes exactly that permission id; already gone is fine; other errors throw", async () => {
    g.permDelete.mockResolvedValue({});
    await revokePermission(auth, "doc1", "p1");
    expect(g.permDelete).toHaveBeenCalledWith({ fileId: "doc1", permissionId: "p1", supportsAllDrives: true });
    expect(g.permList).not.toHaveBeenCalled();
    g.permDelete.mockRejectedValueOnce(Object.assign(new Error("Permission not found"), { code: 404 }));
    await expect(revokePermission(auth, "doc1", "p1")).resolves.toBeUndefined();
    g.permDelete.mockRejectedValueOnce(Object.assign(new Error("backend"), { code: 500 }));
    await expect(revokePermission(auth, "doc1", "p1")).rejects.toThrow("backend");
  });

  it("a share from before 0053 falls back to the address's non-owner permission", async () => {
    g.permList.mockResolvedValue({
      data: {
        permissions: [
          { id: "own", emailAddress: "a@x.se", role: "owner" },
          { id: "w", emailAddress: "a@x.se", role: "writer" },
          { id: "other", emailAddress: "b@x.se", role: "writer" },
        ],
      },
    });
    g.permDelete.mockResolvedValue({});
    await revokeLegacyShare(auth, "doc1", "A@x.se");
    expect(g.permDelete.mock.calls.map((c) => (c[0] as { permissionId: string }).permissionId)).toEqual(["w"]);
  });
});

describe("shared drives (Delade enheter): every Drive call says so", () => {
  const driveCalls = () =>
    [g.list, g.filesCreate, g.filesGet, g.permCreate, g.permList, g.permDelete].flatMap((f) => f.mock.calls.map((c) => [f, c[0] as Record<string, unknown>] as const));

  it("create, folder lookup, sharing and revoking all carry supportsAllDrives; the list also includeItemsFromAllDrives", async () => {
    g.list.mockResolvedValue({ data: { files: [] } });
    g.filesCreate.mockResolvedValueOnce({ data: { id: "folder-new" } }).mockResolvedValue({ data: { id: "doc1" } });
    g.filesGet.mockResolvedValue({ data: { driveId: "drive-1", capabilities: { canAddChildren: true } } });
    g.permList.mockResolvedValue({ data: { permissions: [{ id: "p1", emailAddress: "a@x.se", role: "writer" }] } });
    await createMeetingDoc(auth, { ...input, meetingFolderId: "folderInSharedDrive" });
    await createMeetingDoc(auth, input);
    await shareWith(auth, "doc1", "c@x.se", { checkExisting: true });
    await revokePermission(auth, "doc1", "p1");
    await revokeLegacyShare(auth, "doc1", "a@x.se");
    const calls = driveCalls();
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const [, params] of calls) expect(params).toMatchObject({ supportsAllDrives: true });
    for (const params of g.list.mock.calls.map((c) => c[0])) expect(params).toMatchObject({ includeItemsFromAllDrives: true });
  });
});
