import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

// The förening's Drive account (0070): which grant a Doc call gets, and what a refusal does.

const g = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  updates: [] as { values: unknown; filters: [string, unknown][] }[],
  upserts: [] as Record<string, unknown>[],
  client: vi.fn(),
  getGoogleAuth: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (b: string) => b.replace(/^enc:/, ""), encrypt: (b: string) => `enc:${b}` }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  clientForRefreshToken: g.client,
  getGoogleAuth: g.getGoogleAuth,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      let update: unknown = null;
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        update: (v: unknown) => ((update = v), b),
        upsert: async (v: Record<string, unknown>) => (g.upserts.push(v), { error: null }),
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        is: (c: string, v: unknown) => (filters.push([c, v]), b),
        maybeSingle: async () => ({ data: g.row, error: null }),
        then: (resolve: (v: unknown) => unknown) => (update && g.updates.push({ values: update, filters }), resolve({ error: null })),
      };
      return b;
    },
  }),
}));

const { creationAuth, docAuth, DriveAccountLostError, orgDriveClient, pickerAuth, storeOrgDriveAccount } = await import("./drive-account");

const ORG = "org-ekdala";
const row = (over: Record<string, unknown> = {}) => ({
  org_id: ORG,
  connected_by: "u-admin",
  google_sub: "sub-ekdala",
  google_email: "styrelsen@ekdala.test",
  folder_id: "folderAAAAAAAAAA",
  lost_at: null,
  updated_at: "2026-11-01T00:00:00Z",
  refresh_token_enc: "enc:rt-ekdala",
  ...over,
});

beforeEach(() => {
  g.row = row();
  g.updates = [];
  g.upserts = [];
  g.client.mockReset().mockImplementation(async (label: string, token: string) => ({ label, token }));
  g.getGoogleAuth.mockReset().mockImplementation(async (userId: string) => ({ user: userId }));
});

describe("orgDriveClient", () => {
  it("the very account that made the Doc, its own refresh token", async () => {
    expect(await orgDriveClient(ORG, "sub-ekdala")).toEqual({ label: `org:${ORG}`, token: "rt-ekdala" });
  });

  it("replaced, lost or gone: DriveAccountLostError (a GoogleAuthLostError), no client at all", async () => {
    g.row = row({ google_sub: "sub-other" });
    await expect(orgDriveClient(ORG, "sub-ekdala")).rejects.toBeInstanceOf(DriveAccountLostError);
    g.row = row({ lost_at: "2026-11-20T00:00:00Z" });
    await expect(orgDriveClient(ORG, "sub-ekdala")).rejects.toBeInstanceOf(GoogleAuthLostError);
    g.row = null;
    await expect(orgDriveClient(ORG, "sub-ekdala")).rejects.toBeInstanceOf(DriveAccountLostError);
    expect(g.client).not.toHaveBeenCalled();
  });

  it("Google refuses it: marked lost (kept for the admins' banner), never deleted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    g.client.mockRejectedValue(new GoogleAuthLostError(`org:${ORG}`, "invalid_grant"));
    await expect(orgDriveClient(ORG, "sub-ekdala")).rejects.toBeInstanceOf(DriveAccountLostError);
    expect(g.updates).toHaveLength(1);
    expect(g.updates[0].values).toMatchObject({ lost_at: expect.any(String) });
    expect(g.updates[0].filters).toEqual([["org_id", ORG], ["google_sub", "sub-ekdala"], ["lost_at", null]]);
  });
});

describe("docAuth / creationAuth / pickerAuth: the fallback is only ever 'no förening account'", () => {
  it("an existing Doc of the starter's grant stays with the starter", async () => {
    expect(await docAuth({ orgId: ORG, startedBy: "u1", driveAccountSub: null })).toEqual({ user: "u1" });
  });

  it("a new Doc for the account's folder: the förening's account; for another folder or none: the starter", async () => {
    expect(await creationAuth(ORG, "folderAAAAAAAAAA", "u1")).toEqual({ auth: { label: `org:${ORG}`, token: "rt-ekdala" }, driveAccount: { sub: "sub-ekdala", email: "styrelsen@ekdala.test" } });
    expect(await creationAuth(ORG, "folderBBBBBBBBBB", "u1")).toEqual({ auth: { user: "u1" }, driveAccount: null });
    expect(await creationAuth(ORG, null, "u1")).toEqual({ auth: { user: "u1" }, driveAccount: null });
  });

  it("a lost account for its folder: throws, never the starter's grant", async () => {
    g.row = row({ lost_at: "2026-11-20T00:00:00Z" });
    await expect(creationAuth(ORG, "folderAAAAAAAAAA", "u1")).rejects.toBeInstanceOf(DriveAccountLostError);
    expect(g.getGoogleAuth).not.toHaveBeenCalled();
  });

  it("the Picker: the connecting admin gets the förening's account, others their own", async () => {
    expect((await pickerAuth("u-admin", ORG)).account).toEqual({ sub: "sub-ekdala", email: "styrelsen@ekdala.test" });
    expect(await pickerAuth("u-other", ORG)).toEqual({ auth: { user: "u-other" }, account: null });
    expect(await pickerAuth("u-admin", null)).toEqual({ auth: { user: "u-admin" }, account: null });
  });
});

describe("storeOrgDriveAccount", () => {
  it("encrypted; the same account again keeps its folder and clears lost; another account starts without a folder", async () => {
    await storeOrgDriveAccount({ orgId: ORG, connectedBy: "u-admin", googleSub: "sub-ekdala", googleEmail: "Styrelsen@ekdala.test", refreshToken: "rt2", scope: "s" });
    expect(g.upserts[0]).toMatchObject({ refresh_token_enc: "enc:rt2", google_email: "styrelsen@ekdala.test", folder_id: "folderAAAAAAAAAA", lost_at: null });
    await storeOrgDriveAccount({ orgId: ORG, connectedBy: "u-admin", googleSub: "sub-new", googleEmail: "ny@ekdala.test", refreshToken: "rt3", scope: "s" });
    expect(g.upserts[1]).toMatchObject({ google_sub: "sub-new", folder_id: null });
    expect(JSON.stringify(g.upserts)).not.toContain('"rt2"');
  });

  it("replacing an account another admin connected is recorded and reported; renewing your own is not", async () => {
    expect(await storeOrgDriveAccount({ orgId: ORG, connectedBy: "u-admin", googleSub: "sub-ekdala", googleEmail: "styrelsen@ekdala.test", refreshToken: "r", scope: "s" })).toEqual({ replaced: null });
    expect(g.upserts[0]).toMatchObject({ replaced_by: null, replaced_email: null });
    const r = await storeOrgDriveAccount({ orgId: ORG, connectedBy: "u-other", googleSub: "sub-new", googleEmail: "ny@ekdala.test", refreshToken: "r", scope: "s" });
    expect(r).toEqual({ replaced: { email: "styrelsen@ekdala.test", connectedBy: "u-admin" } });
    expect(g.upserts[1]).toMatchObject({ replaced_by: "u-other", replaced_email: "styrelsen@ekdala.test", replaced_at: expect.any(String) });
  });
});
