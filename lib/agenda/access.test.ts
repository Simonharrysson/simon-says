import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/google/docs", () => ({ driveApi: () => ({ files: { get: m.get } }) }));

const { checkAgendaDoc } = await import("./access");
const auth = {} as never;
const file = (over: Record<string, unknown> = {}) => ({
  data: {
    id: "d1",
    name: "Mötesprotokoll v48",
    mimeType: "application/vnd.google-apps.document",
    trashed: false,
    capabilities: { canEdit: true },
    ...over,
  },
});

beforeEach(() => {
  m.get.mockReset();
});

describe("checkAgendaDoc", () => {
  it("ok with the name for an editable Google Doc; asks only for the fields it needs", async () => {
    m.get.mockResolvedValue(file());
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: true, name: "Mötesprotokoll v48" });
    expect(m.get).toHaveBeenCalledWith({
      fileId: "d1",
      fields: "id,name,mimeType,trashed,capabilities(canEdit)",
      supportsAllDrives: true,
    });
  });

  it("not_doc for a PDF, no_edit without edit rights, trashed for a trashed Doc", async () => {
    m.get.mockResolvedValue(file({ mimeType: "application/pdf" }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "not_doc" });
    m.get.mockResolvedValue(file({ capabilities: { canEdit: false } }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "no_edit" });
    m.get.mockResolvedValue(file({ capabilities: undefined }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "no_edit" });
    m.get.mockResolvedValue(file({ trashed: true }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "trashed" });
  });

  it("not_found when the grant cannot see the file (404 or 403)", async () => {
    m.get.mockRejectedValue(Object.assign(new Error("File not found"), { code: 404 }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "not_found" });
    m.get.mockRejectedValue(Object.assign(new Error("forbidden"), { response: { status: 403 } }));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "not_found" });
  });

  it("a 403 for lack of access is not_found; a 403 rate limit (or unknown reason) is thrown", async () => {
    const e403 = (reason: string, where: "errors" | "response") =>
      Object.assign(
        new Error(reason),
        where === "errors"
          ? { code: 403, errors: [{ reason }] }
          : { response: { status: 403, data: { error: { errors: [{ reason }] } } } },
      );
    m.get.mockRejectedValue(e403("insufficientFilePermissions", "errors"));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "not_found" });
    m.get.mockRejectedValue(e403("appNotAuthorizedToFile", "response"));
    expect(await checkAgendaDoc(auth, "d1")).toEqual({ ok: false, error: "not_found" });
    for (const reason of ["userRateLimitExceeded", "rateLimitExceeded", "dailyLimitExceeded"]) {
      m.get.mockRejectedValue(e403(reason, "errors"));
      await expect(checkAgendaDoc(auth, "d1")).rejects.toThrow(reason);
      m.get.mockRejectedValue(e403(reason, "response"));
      await expect(checkAgendaDoc(auth, "d1")).rejects.toThrow(reason);
    }
  });

  it("other Drive errors are thrown", async () => {
    m.get.mockRejectedValue(Object.assign(new Error("backend"), { code: 500 }));
    await expect(checkAgendaDoc(auth, "d1")).rejects.toThrow("backend");
  });
});
