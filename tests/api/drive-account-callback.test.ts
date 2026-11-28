import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

useTestEnv();

// GET /api/google/drive-account/callback (0070): Google's answer to "Använd ett annat
// Google-konto". Fictional förening and accounts.

const m = vi.hoisted(() => ({
  user: { id: "u-admin" } as { id: string } | null,
  role: "admin" as string | null,
  org: { id: "", kind: "forening", name: "Ekdala IF" } as { id: string; kind?: string; name?: string } | null,
  foretag: false,
  exchange: vi.fn(),
  store: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }),
}));
vi.mock("@/lib/db/orgs", () => ({
  getOrg: async () => m.org,
  myRole: async () => m.role,
  listPeople: async () => [{ member_user_id: "u-admin", name: "Anna Berg" }],
}));
vi.mock("@/lib/foretag/guard", () => ({ isForetagOrg: async () => m.foretag }));
vi.mock("@/lib/google/drive-account", () => ({ storeOrgDriveAccount: m.store }));
vi.mock("@/lib/google/drive-account-notify", () => ({ notifyDriveAccountReplaced: m.notify }));
vi.mock("@/lib/google/drive-account-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/drive-account-oauth")>()),
  exchangeDriveAccountCode: m.exchange,
}));

const { GET } = await import("@/app/api/google/drive-account/callback/route");
const { startDriveAccountFlow, STATE_COOKIE } = await import("@/lib/google/drive-account-oauth");

const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT = { refreshToken: "rt", scope: "openid email https://www.googleapis.com/auth/drive.file", sub: "sub-ekdala", email: "styrelsen@ekdala.test" };

function answer(params: Record<string, string>, opts: { cookie?: string | null } = {}) {
  const flow = startDriveAccountFlow({ userId: "u-admin", orgId: ORG, from: "kom-igang" });
  const state = new URL(flow.url).searchParams.get("state")!;
  const url = new URL("https://example.com/api/google/drive-account/callback");
  for (const [k, v] of Object.entries({ state, ...params })) url.searchParams.set(k, v);
  const cookie = opts.cookie === undefined ? flow.cookie : opts.cookie;
  return GET(new NextRequest(url, { headers: cookie ? { cookie: `${STATE_COOKIE}=${cookie}` } : {} }));
}
const location = (res: Response) => res.headers.get("location");

beforeEach(() => {
  m.user = { id: "u-admin" };
  m.role = "admin";
  m.org = { id: ORG, kind: "forening", name: "Ekdala IF" };
  m.foretag = false;
  m.exchange.mockReset().mockResolvedValue({ ok: true, account: ACCOUNT });
  m.store.mockReset().mockResolvedValue({ replaced: null });
  m.notify.mockReset().mockResolvedValue(1);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("GET /api/google/drive-account/callback", () => {
  it("the admin who started it: stores the account for the förening, back to the step, cookie cleared", async () => {
    const res = await answer({ code: "c1" });
    expect(location(res)).toBe(`https://example.com/orgs/${ORG}/kom-igang?steg=3&drivekonto=ok`);
    expect(m.store).toHaveBeenCalledWith({ orgId: ORG, connectedBy: "u-admin", googleSub: "sub-ekdala", googleEmail: "styrelsen@ekdala.test", refreshToken: "rt", scope: ACCOUNT.scope });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${STATE_COOKIE}=;.*Max-Age=0`, "i"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("CSRF: no cookie, a forged state or another signed-in user stores nothing", async () => {
    expect(location(await answer({ code: "c1" }, { cookie: null }))).toBe("https://example.com/");
    expect(location(await answer({ code: "c1", state: "forged" }))).toBe("https://example.com/");
    m.user = { id: "u-someone-else" };
    expect(location(await answer({ code: "c1" }))).toBe("https://example.com/");
    m.user = null;
    expect(location(await answer({ code: "c1" }))).toBe("https://example.com/login");
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });

  it("no longer an admin (or a Företag / Privat space) by the time Google answers: nothing stored", async () => {
    m.role = "member";
    expect(location(await answer({ code: "c1" }))).toBe(`https://example.com/orgs/${ORG}`);
    m.role = "admin";
    m.foretag = true;
    await answer({ code: "c1" });
    m.foretag = false;
    m.org = { id: ORG, kind: "privat" };
    await answer({ code: "c1" });
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });

  it("cancelled at Google or Drive unticked: nej; a failure: fel; nothing stored", async () => {
    expect(location(await answer({ error: "access_denied" }))).toMatch(/drivekonto=nej$/);
    m.exchange.mockResolvedValue({ ok: false, reason: "no_drive" });
    expect(location(await answer({ code: "c1" }))).toMatch(/drivekonto=nej$/);
    m.exchange.mockResolvedValue({ ok: false, reason: "identity" });
    expect(location(await answer({ code: "c1" }))).toMatch(/drivekonto=fel$/);
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.exchange.mockRejectedValue(new Error("invalid_grant"));
    expect(location(await answer({ code: "c1" }))).toMatch(/drivekonto=fel$/);
    expect(m.store).not.toHaveBeenCalled();
  });

  it("replacing another admin's account tells the other admins; renewing your own tells no one", async () => {
    await answer({ code: "c1" });
    expect(m.notify).not.toHaveBeenCalled();
    m.store.mockResolvedValue({ replaced: { email: "gamla@ekdala.test", connectedBy: "u-other" } });
    expect(location(await answer({ code: "c1" }))).toMatch(/drivekonto=ok$/);
    expect(m.notify).toHaveBeenCalledWith({ orgId: ORG, orgName: "Ekdala IF", byUserId: "u-admin", byName: "Anna Berg", oldEmail: "gamla@ekdala.test", newEmail: "styrelsen@ekdala.test" });
  });
});
