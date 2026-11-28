import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

const m = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  env: { GOOGLE_PICKER_API_KEY: "dev-key" as string | undefined, GOOGLE_PROJECT_NUMBER: "123456789012" as string | undefined },
  getGoogleAuth: vi.fn(),
  role: "admin" as string | null,
  /** org_drive_accounts (0070) for the förening, or none. */
  account: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db/orgs", () => ({ myRole: async () => m.role }));
vi.mock("@/lib/crypto", () => ({ decrypt: (b: string) => b, encrypt: (b: string) => b }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "update"]) b[op] = () => b;
      b.maybeSingle = async () => ({ data: m.account, error: null });
      return b;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getEnv: () => m.env,
}));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
  clientForRefreshToken: async (label: string, token: string) => ({ credentials: { access_token: `at-of-${token}`, expiry_date: 1_900_000_000_000 }, label }),
}));

const { POST } = await import("@/app/api/google/picker-token/route");
const call = (body?: unknown) =>
  POST(new NextRequest("https://x.test/api/google/picker-token", { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }));
const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT = { org_id: ORG, connected_by: "u1", google_sub: "sub-f", google_email: "styrelsen@forening.test", folder_id: null, lost_at: null, updated_at: "2026-11-01T00:00:00Z", refresh_token_enc: "org-refresh" };

describe("POST /api/google/picker-token", () => {
  beforeEach(() => {
    m.user = { id: "u1" };
    m.env = { GOOGLE_PICKER_API_KEY: "dev-key", GOOGLE_PROJECT_NUMBER: "123456789012" };
    m.getGoogleAuth.mockReset();
    m.role = "admin";
    m.account = null;
    m.getGoogleAuth.mockResolvedValue({
      credentials: { access_token: "ya29.access", expiry_date: 1_900_000_000_000, refresh_token: "1//refresh-secret" },
    });
  });

  it("no session → 401 unauthenticated", async () => {
    m.user = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
    expect(m.getGoogleAuth).not.toHaveBeenCalled();
  });

  it("ok → exactly accessToken, expiresAt, developerKey, appId; no-store; never the refresh token", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("refresh");
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["accessToken", "account", "appId", "developerKey", "expiresAt"]);
    expect(body).toEqual({ accessToken: "ya29.access", expiresAt: 1_900_000_000_000, developerKey: "dev-key", appId: "123456789012", account: null });
    expect(m.getGoogleAuth).toHaveBeenCalledWith("u1");
  });

  it("env absent → 503 picker_off, without touching Google", async () => {
    m.env = { GOOGLE_PICKER_API_KEY: undefined, GOOGLE_PROJECT_NUMBER: undefined };
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("picker_off");
    expect(m.getGoogleAuth).not.toHaveBeenCalled();
  });

  it("a lost grant → 401 google_auth_lost with the v1 message", async () => {
    m.getGoogleAuth.mockRejectedValue(new GoogleAuthLostError("u1", "invalid_grant"));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "google_auth_lost",
      message: "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.",
    });
  });

  it("Google down → 502, no token", async () => {
    m.getGoogleAuth.mockRejectedValue(new Error("ECONNRESET"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("google_unavailable");
  });

  describe("the förening's Drive account (0070)", () => {
    it("the admin who connected it gets that account's token, and its address", async () => {
      m.account = ACCOUNT;
      const res = await call({ orgId: ORG });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["accessToken", "account", "appId", "developerKey", "expiresAt"]);
      expect(JSON.parse(text)).toMatchObject({ accessToken: "at-of-org-refresh", account: "styrelsen@forening.test" });
      expect(m.getGoogleAuth).not.toHaveBeenCalled();
    });

    it("another admin, or a member, keeps their own Drive", async () => {
      m.account = { ...ACCOUNT, connected_by: "someone-else" };
      expect(await (await call({ orgId: ORG })).json()).toMatchObject({ accessToken: "ya29.access", account: null });
      m.account = ACCOUNT;
      m.role = "member";
      expect(await (await call({ orgId: ORG })).json()).toMatchObject({ accessToken: "ya29.access", account: null });
    });

    it("a lost account → 409 drive_account_lost, never the admin's own token instead", async () => {
      m.account = { ...ACCOUNT, lost_at: "2026-11-20T00:00:00Z" };
      const res = await call({ orgId: ORG });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("drive_account_lost");
      expect(m.getGoogleAuth).not.toHaveBeenCalled();
    });
  });
});
