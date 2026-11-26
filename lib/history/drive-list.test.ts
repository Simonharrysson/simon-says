import { describe, expect, it } from "vitest";
import {
  DOC_MIME,
  DOCX_MIME,
  FOLDER_MIME,
  isInsufficientScope,
  listFilesInFolders,
  listFolders,
  looksLikeNonProtocol,
  qString,
  resolveFolders,
  titleDate,
  type DriveLike,
} from "./drive-list";

// A fake Drive: a tree of fictional folders and Docs (Brädspelsföreningen Rutan), answering the
// `'<id>' in parents` queries the import's folder browser sends, in pages.

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  driveId?: string;
  modifiedTime?: string;
  createdTime?: string;
}

const id = (s: string) => `${s}`.padEnd(12, "x");
const tree: Node[] = [
  { id: id("protokoll"), name: "Protokoll", mimeType: FOLDER_MIME, parent: "root" },
  { id: id("ht25"), name: "HT25", mimeType: FOLDER_MIME, parent: id("protokoll") },
  { id: id("d1"), name: "Styrelsemöte 2025-09-02", mimeType: DOC_MIME, parent: id("protokoll"), createdTime: "2025-09-02T18:00:00Z", modifiedTime: "2025-09-03T10:00:00Z" },
  { id: id("d2"), name: "Protokoll 14 okt", mimeType: DOC_MIME, parent: id("ht25"), createdTime: "2025-10-14T18:00:00Z", modifiedTime: "2025-10-20T10:00:00Z" },
  { id: id("d3"), name: "Mall styrelseprotokoll", mimeType: DOC_MIME, parent: id("protokoll"), createdTime: "2024-01-01T10:00:00Z" },
  { id: id("d4"), name: "Årsmöte 250315.docx", mimeType: DOCX_MIME, parent: id("protokoll"), createdTime: "2025-03-15T10:00:00Z" },
  { id: id("sheet"), name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parent: id("protokoll") },
];

function fakeDrive(nodes: Node[], pageSize = 2) {
  const calls: Record<string, unknown>[] = [];
  const api: DriveLike = {
    files: {
      async list(p) {
        calls.push(p);
        const q = String(p.q);
        const parent = /^'([^']+)' in parents/.exec(q)?.[1];
        const mimes = [...q.matchAll(/mimeType = '([^']+)'/g)].map((m) => m[1]);
        let hits = nodes.filter((n) => (parent ? n.parent === parent : true) && mimes.includes(n.mimeType));
        if (q.startsWith("name contains")) {
          const term = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)![1].replace(/\\(.)/g, "$1");
          hits = hits.filter((n) => n.name.toLowerCase().includes(term.toLowerCase()));
        }
        const start = p.pageToken ? Number(p.pageToken) : 0;
        const page = hits.slice(start, start + pageSize);
        return { data: { files: page.map((n) => ({ ...n })), nextPageToken: start + pageSize < hits.length ? String(start + pageSize) : null } };
      },
      async get(p) {
        calls.push(p);
        const n = nodes.find((x) => x.id === p.fileId);
        if (!n) throw Object.assign(new Error("File not found"), { code: 404 });
        return { data: { ...n } };
      },
    },
    drives: {
      async list() {
        return { data: { drives: [{ id: id("sharedrive"), name: "Rutans delade enhet" }], nextPageToken: null } };
      },
    },
  };
  return { api, calls };
}

describe("qString", () => {
  it("escapes quotes and backslashes so a search cannot break out of the q literal", () => {
    expect(qString("Rutan's")).toBe("'Rutan\\'s'");
    expect(qString("a\\' or trashed = true or '")).toBe("'a\\\\\\' or trashed = true or \\''");
  });
});

describe("listFolders", () => {
  it("lists My Drive's top folders with shared drives included, never files", async () => {
    const { api, calls } = fakeDrive(tree);
    const r = await listFolders(api, { place: "root" });
    expect(r.folders).toEqual([{ id: id("protokoll"), name: "Protokoll" }]);
    expect(calls[0]).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true });
    expect(String(calls[0].q)).toContain(`mimeType = '${FOLDER_MIME}'`);
  });

  it("lists shared drives as folders carrying their driveId", async () => {
    const { api } = fakeDrive(tree);
    expect((await listFolders(api, { place: "drives" })).folders).toEqual([{ id: id("sharedrive"), name: "Rutans delade enhet", driveId: id("sharedrive") }]);
  });

  it("a folder inside a shared drive is queried in that drive", async () => {
    const { api, calls } = fakeDrive(tree);
    await listFolders(api, { place: "folder", id: id("protokoll"), driveId: id("sharedrive") });
    expect(calls[0]).toMatchObject({ corpora: "drive", driveId: id("sharedrive") });
  });

  it("searches folders by name, escaping the text", async () => {
    const { api, calls } = fakeDrive(tree);
    const r = await listFolders(api, { place: "search", query: "ht2" });
    expect(r.folders.map((f) => f.name)).toEqual(["HT25"]);
    await listFolders(api, { place: "search", query: "x' or name contains '" });
    expect(String(calls[1].q)).toContain("'x\\' or name contains \\''");
  });

  it("refuses a malformed folder id before calling Drive", async () => {
    const { api, calls } = fakeDrive(tree);
    await expect(listFolders(api, { place: "folder", id: "' in parents or '" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("listFilesInFolders", () => {
  it("lists Docs (and .docx, not importable) in the folder, paging, sorted by date", async () => {
    const { api } = fakeDrive(tree);
    const r = await listFilesInFolders(api, [{ id: id("protokoll"), name: "Protokoll" }], { subfolders: false });
    expect(r.files.map((f) => [f.name, f.date, f.dateInferred, f.status])).toEqual([
      ["Mall styrelseprotokoll", "2024-01-01", true, "template"],
      ["Årsmöte 250315.docx", "2025-03-15", false, "docx"],
      ["Styrelsemöte 2025-09-02", "2025-09-02", false, "ready"],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("with subfolders: walks them and names the folder each Doc is in", async () => {
    const { api } = fakeDrive(tree);
    const r = await listFilesInFolders(api, [{ id: id("protokoll"), name: "Protokoll" }], { subfolders: true });
    const d2 = r.files.find((f) => f.id === id("d2"))!;
    expect(d2).toMatchObject({ folderName: "HT25", date: "2025-10-14", dateInferred: true, status: "ready" });
    expect(r.folders).toBe(2);
  });

  it("a Doc reached twice (two ticked folders) is listed once", async () => {
    const { api } = fakeDrive(tree);
    const r = await listFilesInFolders(api, [{ id: id("protokoll"), name: "Protokoll" }, { id: id("ht25"), name: "HT25" }], { subfolders: true });
    expect(r.files.filter((f) => f.id === id("d2"))).toHaveLength(1);
  });

  it("Drive answering with an incomplete search counts as truncated", async () => {
    const { api } = fakeDrive(tree);
    const list = api.files.list;
    api.files.list = async (p) => ({ data: { ...(await list(p)).data, incompleteSearch: true } });
    expect((await listFilesInFolders(api, [{ id: id("ht25"), name: "HT25" }], { subfolders: false })).truncated).toBe(true);
  });

  it("stops at the folder cap and says so", async () => {
    const many: Node[] = [{ id: id("top"), name: "Top", mimeType: FOLDER_MIME, parent: "root" }];
    for (let i = 0; i < 80; i++) many.push({ id: id(`sub${i}`), name: `Sub ${i}`, mimeType: FOLDER_MIME, parent: id("top") });
    const { api } = fakeDrive(many, 200);
    const r = await listFilesInFolders(api, [{ id: id("top"), name: "Top" }], { subfolders: true });
    expect(r.truncated).toBe(true);
    expect(r.folders).toBe(60);
  });
});

describe("resolveFolders", () => {
  it("returns the folder as Drive names it; a Doc id is refused", async () => {
    const { api } = fakeDrive(tree);
    expect(await resolveFolders(api, [{ id: id("ht25") }])).toEqual([{ id: id("ht25"), name: "HT25" }]);
    await expect(resolveFolders(api, [{ id: id("d1") }])).rejects.toThrow("not a folder");
  });
});

describe("titleDate", () => {
  const file = { modifiedTime: "2026-02-20T10:00:00Z", createdTime: "2026-01-05T10:00:00Z" };
  it("reads full dates in the title", () => {
    expect(titleDate("Protokoll 2025-09-02", file)).toEqual({ date: "2025-09-02", inferred: false });
    expect(titleDate("Board meeting 4 Sep 2025", file)).toEqual({ date: "2025-09-04", inferred: false });
    expect(titleDate("Styrelsemöte 10/9-25", file)).toEqual({ date: "2025-09-10", inferred: false });
  });
  it("reads compact dates (yymmdd, yyyymmdd)", () => {
    expect(titleDate("250902 Styrelsemöte", file)).toEqual({ date: "2025-09-02", inferred: false });
    expect(titleDate("Protokoll 20250902", file)).toEqual({ date: "2025-09-02", inferred: false });
  });
  it("a date without a year gets the year on or before the last edit, flagged", () => {
    expect(titleDate("Möte 12 feb", file)).toEqual({ date: "2026-02-12", inferred: true });
    expect(titleDate("Möte 12 dec", file)).toEqual({ date: "2025-12-12", inferred: true });
  });
  it("no date: the creation date, flagged", () => {
    expect(titleDate("Styrelsemöte", file)).toEqual({ date: "2026-01-05", inferred: true });
  });
});

describe("looksLikeNonProtocol", () => {
  it("flags templates, agendas and calls to meetings", () => {
    for (const t of ["Mall styrelseprotokoll", "Template minutes", "Kallelse årsmöte 2025", "Dagordning 12/3"]) expect(looksLikeNonProtocol(t)).toBe(true);
  });
  it("keeps protocols, also ones that mention the agenda", () => {
    for (const t of ["Protokoll 2025-09-02", "Styrelsemöte 12/3", "Protokoll och dagordning 12/3", "Malldiskussion?"]) expect(looksLikeNonProtocol(t)).toBe(false);
  });
});

describe("isInsufficientScope", () => {
  it("is true for Drive's 403 insufficient scope, false for a plain 403 or 404", () => {
    expect(isInsufficientScope({ response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } })).toBe(true);
    expect(isInsufficientScope({ code: 403, message: "Request had insufficient authentication scopes." })).toBe(true);
    expect(isInsufficientScope({ code: 403, message: "The user does not have sufficient permissions for this file." })).toBe(false);
    expect(isInsufficientScope({ code: 404, message: "insufficient" })).toBe(false);
  });
});
