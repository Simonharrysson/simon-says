import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

// Fictional förening: starters s1/s2, a member who joins later (nyss@ekdala.test).

const g = vi.hoisted(() => ({
  permCreate: vi.fn(),
  getGoogleAuth: vi.fn(),
  meetings: [] as { id: string; doc_id: string; started_by: string | null; agenda_doc: boolean }[],
  shared: [] as { meeting_id: string; user_id: string }[],
  upserts: [] as unknown[],
  filters: [] as [string, string, unknown][],
  upsertError: null as { code?: string; message: string } | null,
}));

vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: (auth: { who: string }) => ({
    permissions: { create: (args: unknown) => g.permCreate(auth.who, args) },
  }),
}));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: g.getGoogleAuth,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "not", "in", "order", "limit"]) {
        b[op] = (...args: unknown[]) => (g.filters.push([table, op, args]), b);
      }
      b.upsert = async (rows: unknown) => (g.upserts.push(rows), { error: g.upsertError });
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "meetings" ? g.meetings : g.shared, error: null });
      return b;
    },
  }),
}));

const { recordDocShares, shareMeetingDocWith, shareOrgDocsWithNewMember } = await import("./access");

const NEW = { id: "u-new", email: "nyss@ekdala.test" };

beforeEach(() => {
  g.permCreate.mockReset().mockResolvedValue({ data: {} });
  g.getGoogleAuth.mockReset().mockImplementation(async (who: string) => ({ who }));
  g.meetings = [];
  g.shared = [];
  g.upserts = [];
  g.filters = [];
  g.upsertError = null;
});

describe("shareOrgDocsWithNewMember", () => {
  it("shares earlier Docs through each starter's own grant, skips ones already shared, records each", async () => {
    g.meetings = [
      { id: "m1", doc_id: "d1", started_by: "s1", agenda_doc: false },
      { id: "m2", doc_id: "d2", started_by: "s2", agenda_doc: false },
      { id: "m3", doc_id: "d3", started_by: "s1", agenda_doc: false },
    ];
    g.shared = [{ meeting_id: "m3", user_id: NEW.id }];
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(2);
    expect(g.permCreate.mock.calls.map(([who, a]) => [who, (a as { fileId: string }).fileId])).toEqual([
      ["s1", "d1"],
      ["s2", "d2"],
    ]);
    expect(g.permCreate.mock.calls[0][1]).toMatchObject({
      sendNotificationEmail: false,
      requestBody: { role: "writer", type: "user", emailAddress: NEW.email },
    });
    expect(g.upserts).toEqual([[{ meeting_id: "m1", user_id: NEW.id }], [{ meeting_id: "m2", user_id: NEW.id }]]);
    // Only Docs Simon Says created, never the new member's own meetings.
    const meetingFilters = g.filters.filter((f) => f[0] === "meetings").map((f) => [f[1], ...(f[2] as unknown[])]);
    expect(meetingFilters).toContainEqual(["eq", "agenda_doc", false]);
    expect(meetingFilters).toContainEqual(["neq", "started_by", NEW.id]);
  });

  it("a starter whose Google connection lapsed is skipped; the others still share", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.meetings = [
      { id: "m1", doc_id: "d1", started_by: "s1", agenda_doc: false },
      { id: "m2", doc_id: "d2", started_by: "s2", agenda_doc: false },
    ];
    g.getGoogleAuth.mockImplementation(async (who: string) => {
      if (who === "s1") throw new GoogleAuthLostError(who, "invalid_grant");
      return { who };
    });
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(1);
    expect(g.permCreate.mock.calls.map(([who]) => who)).toEqual(["s2"]);
  });

  it("a failed share is not recorded (the member can ask on the org page)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.meetings = [{ id: "m1", doc_id: "d1", started_by: "s1", agenda_doc: false }];
    g.permCreate.mockRejectedValue(new Error("not a Google account"));
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(0);
    expect(g.upserts).toEqual([]);
  });
});

describe("shareMeetingDocWith", () => {
  const meeting = { id: "m1", doc_id: "d1", started_by: "s1", agenda_doc: false };

  it("shares through the starter's grant and records it", async () => {
    expect(await shareMeetingDocWith(meeting, NEW)).toBe("shared");
    expect(g.getGoogleAuth).toHaveBeenCalledWith("s1");
    expect(g.upserts).toEqual([[{ meeting_id: "m1", user_id: NEW.id }]]);
  });

  it("never shares the förening's own agenda Doc, and needs a starter", async () => {
    expect(await shareMeetingDocWith({ ...meeting, agenda_doc: true }, NEW)).toBe("agenda");
    expect(await shareMeetingDocWith({ ...meeting, started_by: null }, NEW)).toBe("no_starter");
    expect(g.permCreate).not.toHaveBeenCalled();
  });

  it("the starter's lapsed Google connection or a Google refusal: ask the starter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.getGoogleAuth.mockRejectedValueOnce(new GoogleAuthLostError("s1", "invalid_grant"));
    expect(await shareMeetingDocWith(meeting, NEW)).toBe("starter_google_lost");
    g.permCreate.mockRejectedValueOnce(new Error("forbidden"));
    expect(await shareMeetingDocWith(meeting, NEW)).toBe("failed");
    expect(g.upserts).toEqual([]);
  });
});

describe("recordDocShares", () => {
  it("never throws, also without 0030", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    g.upsertError = { code: "PGRST205", message: "no table" };
    await expect(recordDocShares("m1", ["u1"])).resolves.toBeUndefined();
    await recordDocShares("m1", []);
    expect(g.upserts).toHaveLength(1);
  });
});
