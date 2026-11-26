import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  list: vi.fn(),
  filesCreate: vi.fn(),
  filesGet: vi.fn(),
  filesUpdate: vi.fn(),
  permCreate: vi.fn(),
  get: vi.fn(),
  batchUpdate: vi.fn(),
  done: [] as Record<string, unknown>[],
  filters: [] as [string, string, unknown][],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: g.get, batchUpdate: g.batchUpdate } }),
  driveApi: () => ({
    files: { list: g.list, create: g.filesCreate, get: g.filesGet, update: g.filesUpdate },
    permissions: { create: g.permCreate },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: g.done, error: null }),
      };
      b.eq = (col: string, v: unknown) => (g.filters.push(["eq", col, v]), b);
      return b;
    },
  }),
}));

const { createTestAgendaDoc, testRun, trashTestDoc } = await import("./agenda");
const { apply, docOf, paraEl } = await import("@/test/docsim");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { scanAgenda } = await import("@/lib/agenda/scan");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const agenda = (await import("@/fixtures/agenda/veckomote.agenda.json")).default;

const auth = {} as OAuth2Client;
const startedAt = new Date("2026-11-25T17:05:00Z");
let doc: ReturnType<typeof docOf>;

beforeEach(() => {
  Object.values(g).forEach((f) => typeof f === "function" && f.mockReset());
  g.done = [];
  g.filters = [];
  doc = docOf([paraEl("")]);
  g.list.mockResolvedValue({ data: { files: [{ id: "ownFolder" }] } });
  g.filesCreate.mockResolvedValue({ data: { id: "tdoc" } });
  g.filesGet.mockResolvedValue({ data: { capabilities: { canAddChildren: true } } });
  g.get.mockImplementation(async () => ({ data: JSON.parse(JSON.stringify(doc)) }));
  g.batchUpdate.mockImplementation(async ({ requestBody }: { requestBody: { requests: Parameters<typeof apply>[1] } }) => {
    apply(doc, requestBody.requests);
    return { data: { replies: [] } };
  });
});

describe("createTestAgendaDoc", () => {
  it("writes the fictional Veckomöte agenda into a new Doc in the org meeting folder; never shared", async () => {
    expect(await createTestAgendaDoc(auth, { orgName: "Testföreningen", folderId: "meetFolder", startedAt })).toEqual({ docId: "tdoc" });
    expect(g.filesGet.mock.calls[0][0]).toMatchObject({ fileId: "meetFolder", supportsAllDrives: true });
    expect(g.filesCreate.mock.calls[0][0]).toMatchObject({
      requestBody: {
        name: "2026-11-25 18.05 Mötesprotokoll – Testföreningen (Testmöte)",
        mimeType: "application/vnd.google-apps.document",
        parents: ["meetFolder"],
        writersCanShare: false,
      },
      supportsAllDrives: true,
    });
    expect(g.list).not.toHaveBeenCalled();
    expect(g.permCreate).not.toHaveBeenCalled();

    const tab = parseNotesTab(doc, "t.0");
    const lines = tab.paragraphs.filter((p) => !p.inTable).map((p) => p.text.replace(/\n$/, ""));
    for (const item of agenda.items) expect(lines).toContain(item.label);
    for (const sub of agenda.items[3].sub!) expect(lines).toContain(sub);
    expect(lines).toContain("Vad ska vi göra till nästa gång?");
    expect(lines).toContain("Anteckningar");
    expect(lines).not.toContain("Övriga punkter"); // the fixture's own items replace the defaults
    expect(tab.tables![0].rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Datum", ""],
      ["Tid", ""],
      ["Närvarande", ""],
      ["Sekreterare", "Elin Sjöberg"],
    ]);
    // The agenda scan (as anchorAgenda runs it) finds the six items in order.
    expect(scanAgenda(tab, VECKOMOTE).items.map((i) => i.label)).toEqual(agenda.items.map((i) => i.label));
  });

  it("falls back to the starter's own org folder when the meeting folder is not writable, unseen, or unset", async () => {
    g.filesGet.mockResolvedValueOnce({ data: { capabilities: { canAddChildren: false } } });
    await createTestAgendaDoc(auth, { orgName: "Testföreningen", folderId: "meetFolder", startedAt });
    expect(g.filesCreate.mock.calls[0][0].requestBody.parents).toEqual(["ownFolder"]);
    expect(g.list.mock.calls[0][0].q).toContain("name='Simon Says – Testföreningen'");

    g.filesGet.mockRejectedValueOnce(Object.assign(new Error("File not found"), { code: 404 }));
    await createTestAgendaDoc(auth, { orgName: "Testföreningen", folderId: "meetFolder", startedAt });
    expect(g.filesCreate.mock.calls[1][0].requestBody.parents).toEqual(["ownFolder"]);

    g.filesGet.mockClear();
    await createTestAgendaDoc(auth, { orgName: "Testföreningen", folderId: null, startedAt });
    expect(g.filesGet).not.toHaveBeenCalled();
    expect(g.filesCreate.mock.calls[2][0].requestBody.parents).toEqual(["ownFolder"]);
  });

  it("dates the title in Swedish local time", async () => {
    await createTestAgendaDoc(auth, { orgName: "X", folderId: null, startedAt: new Date("2026-11-25T23:30:00Z") });
    expect(g.filesCreate.mock.calls[0][0].requestBody.name).toBe("2026-11-26 00.30 Mötesprotokoll – X (Testmöte)");
  });
});

describe("createTestAgendaDoc failures", () => {
  it("trashes the new file and rethrows when a step after the create fails", async () => {
    g.batchUpdate.mockRejectedValueOnce(new Error("docs down"));
    await expect(createTestAgendaDoc(auth, { orgName: "X", folderId: null, startedAt })).rejects.toThrow("docs down");
    expect(g.filesUpdate).toHaveBeenCalledWith({ fileId: "tdoc", requestBody: { trashed: true }, supportsAllDrives: true });
  });

  it("still rethrows the original error when the trash fails too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.get.mockRejectedValueOnce(new Error("read failed"));
    g.filesUpdate.mockRejectedValueOnce(new Error("trash failed"));
    await expect(createTestAgendaDoc(auth, { orgName: "X", folderId: null, startedAt })).rejects.toThrow("read failed");
  });

  it("no trash when the create itself fails (no file)", async () => {
    g.filesCreate.mockRejectedValueOnce(new Error("drive down"));
    await expect(createTestAgendaDoc(auth, { orgName: "X", folderId: null, startedAt })).rejects.toThrow("drive down");
    expect(g.filesUpdate).not.toHaveBeenCalled();
  });
});

describe("trashTestDoc", () => {
  it("moves the Doc to the trash", async () => {
    await trashTestDoc(auth, "tdoc");
    expect(g.filesUpdate).toHaveBeenCalledWith({ fileId: "tdoc", requestBody: { trashed: true }, supportsAllDrives: true });
  });
});

describe("testRun", () => {
  it("'a' without a done agenda Testmöte in the org, 'b' with one", async () => {
    expect(await testRun("org1")).toBe("a");
    expect(g.filters).toEqual(
      expect.arrayContaining([
        ["eq", "org_id", "org1"],
        ["eq", "status", "done"],
        ["eq", "is_test", true],
        ["eq", "layout", "format"],
        ["eq", "agenda_doc", true],
      ]),
    );
    g.done = [{ id: "m0" }];
    expect(await testRun("org1")).toBe("b");
  });
});
