import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  list: vi.fn(),
  filesCreate: vi.fn(),
  permCreate: vi.fn(),
  get: vi.fn(),
  batchUpdate: vi.fn(),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: g.get, batchUpdate: g.batchUpdate } }),
  driveApi: () => ({ files: { list: g.list, create: g.filesCreate }, permissions: { create: g.permCreate } }),
}));

import { createMeetingDoc, INITIAL_HEADER, meetingTitle } from "./create";

const auth = {} as OAuth2Client;
const M = "11111111-2222-3333-4444-555555555555";
const input = {
  meetingId: M,
  orgName: "LiU AI Society",
  startedAt: new Date("2026-11-24T13:05:00Z"),
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
  it("uses Swedish local time (CET in winter, CEST in summer)", () => {
    expect(meetingTitle("Styrelsen", new Date("2026-11-24T13:05:00Z"))).toBe("Styrelsen möte 2026-11-24 14:05");
    expect(meetingTitle("Styrelsen", new Date("2026-07-01T22:30:00Z"))).toBe("Styrelsen möte 2026-07-02 00:30");
  });
});

describe("createMeetingDoc", () => {
  it("creates the Doc in the existing org folder with the meeting title", async () => {
    await createMeetingDoc(auth, input);
    expect(g.list.mock.calls[0][0].q).toContain("name='Simon Says – LiU AI Society'");
    expect(g.list.mock.calls[0][0].q).toContain("'me' in owners");
    expect(g.filesCreate).toHaveBeenCalledTimes(1);
    expect(g.filesCreate.mock.calls[0][0].requestBody).toEqual({
      name: "LiU AI Society möte 2026-11-24 14:05",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder1"],
      writersCanShare: false, // members edit, only the owner shares further
    });
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
      shareFailed: [],
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
        requestBody: { role: "writer", type: "user", emailAddress: email },
      });
    }
  });

  it("reports addresses it could not share with instead of failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.permCreate.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({ data: {} });
    const r = await createMeetingDoc(auth, input);
    expect(r.shareFailed).toEqual(["a@x.se"]);
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
    expect(res).toEqual({ docId: "doc1", tabId: "t.0", transcriptTabId: "t.1", shareFailed: ["b@x.se"] });
    expect(g.filesCreate.mock.calls[0][0].requestBody.name).toBe("LiU AI Society möte 2026-11-24 14:05");
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
