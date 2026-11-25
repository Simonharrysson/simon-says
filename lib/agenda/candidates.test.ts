import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";

// Fictional file names only.
const drive = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/lib/google/docs", () => ({
  driveApi: () => ({ files: { get: drive.get, list: drive.list } }),
}));

const { listCandidates, rankCandidates } = await import("./candidates");

// 2026-11-25 is a Wednesday; 10:00 in Stockholm.
const NOW = new Date("2026-11-25T09:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const file = (id: string, name: string, created: string, modified: string) => ({
  id,
  name,
  createdTime: created,
  modifiedTime: modified,
});

describe("rankCandidates", () => {
  it("today's date in the title beats a newer modifiedTime", () => {
    const ranked = rankCandidates(
      [file("a", "Mall veckomöte", daysAgo(30), daysAgo(0)), file("b", "Möte 25/11", daysAgo(3), daysAgo(3))],
      NOW,
    );
    expect(ranked.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("puts '2026-11-25 styrelse' first", () => {
    const ranked = rankCandidates(
      [
        file("a", "Mall veckomöte", daysAgo(30), daysAgo(0)),
        file("b", "Planering", daysAgo(1), daysAgo(1)),
        file("c", "2026-11-25 styrelse", daysAgo(5), daysAgo(5)),
      ],
      NOW,
    );
    expect(ranked[0].id).toBe("c");
  });

  it("recognises every date form, case-insensitive, with digit boundaries", () => {
    const dated = ["2026-11-25", "20261125", "25/11", "25.11", "25 nov", "25 November", "Möte 25 NOV kl 18", "25/11/2026"];
    for (const name of dated) {
      const ranked = rankCandidates([file("x", "Annat", daysAgo(9), daysAgo(0)), file("d", name, daysAgo(9), daysAgo(6))], NOW);
      expect(ranked[0].id, name).toBe("d");
    }
    for (const name of ["125/11", "25/115", "2026-11-251", "25 novis"]) {
      const ranked = rankCandidates([file("x", "Annat", daysAgo(9), daysAgo(0)), file("d", name, daysAgo(9), daysAgo(6))], NOW);
      expect(ranked[0].id, name).toBe("x");
    }
  });

  it("uses the Stockholm date (late evening UTC is already tomorrow)", () => {
    // 2026-11-24 23:30 UTC = 2026-11-25 00:30 in Stockholm.
    const late = new Date("2026-11-24T23:30:00Z");
    const ranked = rankCandidates([file("x", "24/11", daysAgo(9), daysAgo(0)), file("d", "25/11", daysAgo(9), daysAgo(6))], late);
    expect(ranked[0].id).toBe("d");
  });

  it("a doc created this week beats one created last week with the same modified time", () => {
    const modified = daysAgo(1);
    const ranked = rankCandidates(
      [
        file("old", "Veckomöte", "2026-11-20T10:00:00Z", modified), // Friday last week
        file("new", "Veckomöte", "2026-11-23T08:00:00Z", modified), // Monday this week
      ],
      NOW,
    );
    expect(ranked.map((f) => f.id)).toEqual(["new", "old"]);
  });

  it("a missing createdTime or modifiedTime does not throw; it ranks last", () => {
    const ranked = rankCandidates([file("bad", "Utan datum", "", ""), file("ok", "Veckomöte", daysAgo(20), daysAgo(2))], NOW);
    expect(ranked.map((f) => f.id)).toEqual(["ok", "bad"]);
  });

  it("otherwise newer modifiedTime first, and the input is not mutated", () => {
    const input = [file("a", "A", daysAgo(20), daysAgo(4)), file("b", "B", daysAgo(20), daysAgo(2))];
    const ranked = rankCandidates(input, NOW);
    expect(ranked.map((f) => f.id)).toEqual(["b", "a"]);
    expect(input.map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("listCandidates", () => {
  const auth = {} as OAuth2Client;
  beforeEach(() => {
    drive.get.mockReset();
    drive.list.mockReset();
  });

  it("a folder the grant cannot see (404) is not accessible", async () => {
    drive.get.mockRejectedValue(Object.assign(new Error("File not found"), { status: 404 }));
    expect(await listCandidates(auth, "folder123456", new Set(), NOW)).toEqual({ accessible: false, candidates: [] });
    expect(drive.list).not.toHaveBeenCalled();
  });

  it("a 403 without access is not accessible; other errors throw", async () => {
    drive.get.mockRejectedValue(Object.assign(new Error("no"), { status: 403, errors: [{ reason: "insufficientFilePermissions" }] }));
    expect((await listCandidates(auth, "folder123456", new Set(), NOW)).accessible).toBe(false);
    drive.get.mockRejectedValue(Object.assign(new Error("slow down"), { status: 403, errors: [{ reason: "rateLimitExceeded" }] }));
    await expect(listCandidates(auth, "folder123456", new Set(), NOW)).rejects.toThrow("slow down");
  });

  it("lists the folder's recent Docs, minus used ones, ranked", async () => {
    drive.get.mockResolvedValue({ data: { id: "folder123456" } });
    drive.list.mockResolvedValue({
      data: {
        files: [
          file("used1", "25/11 gammalt", daysAgo(2), daysAgo(0)),
          file("a", "Mall veckomöte", daysAgo(30), daysAgo(0)),
          file("b", "Möte 25/11", daysAgo(3), daysAgo(3)),
        ],
      },
    });
    const res = await listCandidates(auth, "folder123456", new Set(["used1"]), NOW);
    expect(res.accessible).toBe(true);
    expect(res.candidates.map((f) => f.id)).toEqual(["b", "a"]);

    const params = drive.list.mock.calls[0][0] as { q: string; fields: string; pageSize: number };
    expect(params.q).toContain("'folder123456' in parents");
    expect(params.q).toContain("mimeType='application/vnd.google-apps.document'");
    expect(params.q).toContain("trashed=false");
    expect(params.q).toContain(`modifiedTime > '${daysAgo(7)}'`);
    expect(params.fields).toBe("files(id,name,createdTime,modifiedTime)");
    expect(params.pageSize).toBe(50);
  });

  it("refuses a folder id that is not a Drive id (it goes into the query)", async () => {
    await expect(listCandidates(auth, "x' or '1'='1", new Set(), NOW)).rejects.toThrow(/folder id/);
    expect(drive.get).not.toHaveBeenCalled();
  });
});
