import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

// Fictional förening: starters s1/s2, a member who joins later (nyss@ekdala.test).

const g = vi.hoisted(() => ({
  permCreate: vi.fn(),
  getGoogleAuth: vi.fn(),
  meetings: [] as { id: string; org_id: string; doc_id: string; started_by: string | null; agenda_doc: boolean }[],
  members: ["s1", "s2"] as string[],
  shared: [] as { meeting_id: string; user_id: string }[],
  upserts: [] as unknown[],
  filters: [] as [string, string, unknown][],
  upsertError: null as { code?: string; message: string } | null,
}));

vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: (auth: { who: string }) => ({
    permissions: { create: (args: unknown) => g.permCreate(auth.who, args), list: async () => ({ data: { permissions: [] } }) },
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
        resolve({
          data: table === "meetings" ? g.meetings : table === "org_members" ? g.members.map((user_id) => ({ user_id })) : g.shared,
          error: null,
        });
      return b;
    },
  }),
}));

const { recordDocShares, shareMeetingDocWith, shareOrgDocsWithNewMember } = await import("./access");

const NEW = { id: "u-new", email: "nyss@ekdala.test" };

beforeEach(() => {
  g.permCreate.mockReset().mockResolvedValue({ data: { id: "perm-1" } });
  g.getGoogleAuth.mockReset().mockImplementation(async (who: string) => ({ who }));
  g.meetings = [];
  g.members = ["s1", "s2"];
  g.shared = [];
  g.upserts = [];
  g.filters = [];
  g.upsertError = null;
});

describe("shareOrgDocsWithNewMember", () => {
  it("shares earlier Docs through each starter's own grant, skips ones already shared, records each", async () => {
    g.meetings = [
      { id: "m1", org_id: "org1", doc_id: "d1", started_by: "s1", agenda_doc: false },
      { id: "m2", org_id: "org1", doc_id: "d2", started_by: "s2", agenda_doc: false },
      { id: "m3", org_id: "org1", doc_id: "d3", started_by: "s1", agenda_doc: false },
      // The förening's own agenda Doc: never shared by Simon Says.
      { id: "m4", org_id: "org1", doc_id: "d4", started_by: "s1", agenda_doc: true },
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
    expect(g.upserts).toEqual([[{ meeting_id: "m1", user_id: NEW.id, email: NEW.email, permission_id: "perm-1", preexisting: false }], [{ meeting_id: "m2", user_id: NEW.id, email: NEW.email, permission_id: "perm-1", preexisting: false }]]);
    // Only Docs Simon Says created, never the new member's own meetings.
    const meetingFilters = g.filters.filter((f) => f[0] === "meetings").map((f) => [f[1], ...(f[2] as unknown[])]);
    expect(meetingFilters).toContainEqual(["neq", "started_by", NEW.id]);
  });

  it("a starter whose Google connection lapsed is skipped; the others still share", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.meetings = [
      { id: "m1", org_id: "org1", doc_id: "d1", started_by: "s1", agenda_doc: false },
      { id: "m2", org_id: "org1", doc_id: "d2", started_by: "s2", agenda_doc: false },
    ];
    g.getGoogleAuth.mockImplementation(async (who: string) => {
      if (who === "s1") throw new GoogleAuthLostError(who, "invalid_grant");
      return { who };
    });
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(1);
    expect(g.permCreate.mock.calls.map(([who]) => who)).toEqual(["s2"]);
  });

  it("skips the Docs of a starter who has left the förening", async () => {
    g.meetings = [
      { id: "m1", org_id: "org1", doc_id: "d1", started_by: "s1", agenda_doc: false },
      { id: "m2", org_id: "org1", doc_id: "d2", started_by: "gone", agenda_doc: false },
    ];
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(1);
    expect(g.getGoogleAuth.mock.calls.map((c) => c[0])).toEqual(["s1"]);
  });

  it("a failed share is not recorded (the member can ask on the org page)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    g.meetings = [{ id: "m1", org_id: "org1", doc_id: "d1", started_by: "s1", agenda_doc: false }];
    g.permCreate.mockRejectedValue(new Error("not a Google account"));
    expect(await shareOrgDocsWithNewMember("org1", NEW)).toBe(0);
    expect(g.upserts).toEqual([]);
  });
});

describe("shareMeetingDocWith", () => {
  const meeting = { id: "m1", org_id: "org1", doc_id: "d1", started_by: "s1", agenda_doc: false };

  it("shares through the starter's grant and records it", async () => {
    expect(await shareMeetingDocWith(meeting, NEW)).toBe("shared");
    expect(g.getGoogleAuth).toHaveBeenCalledWith("s1");
    expect(g.upserts).toEqual([[{ meeting_id: "m1", user_id: NEW.id, email: NEW.email, permission_id: "perm-1", preexisting: false }]]);
  });

  it("only Docs Simon Says created: the förening's own agenda Doc is never shared, with no Drive call", async () => {
    expect(await shareMeetingDocWith({ ...meeting, agenda_doc: true }, NEW)).toBe("not_ours");
    expect(await shareMeetingDocWith({ ...meeting, agenda_doc: true, app_created_doc: false }, NEW)).toBe("not_ours");
    expect(g.getGoogleAuth).not.toHaveBeenCalled();
    expect(g.permCreate).not.toHaveBeenCalled();
    // An agenda Doc Simon Says made (the Testmöte agenda) is ours.
    expect(await shareMeetingDocWith({ ...meeting, agenda_doc: true, app_created_doc: true }, NEW)).toBe("shared");
  });

  it("needs a starter who is still in the förening: never uses a departed member's Google grant", async () => {
    expect(await shareMeetingDocWith({ ...meeting, started_by: null }, NEW)).toBe("no_starter");
    g.members = ["s2"];
    expect(await shareMeetingDocWith(meeting, NEW)).toBe("no_starter");
    expect(g.getGoogleAuth).not.toHaveBeenCalled();
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
