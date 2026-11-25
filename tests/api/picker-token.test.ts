import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

const m = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  env: { GOOGLE_PICKER_API_KEY: "dev-key" as string | undefined, GOOGLE_PROJECT_NUMBER: "123456789012" as string | undefined },
  getGoogleAuth: vi.fn(),
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
}));

const { POST } = await import("@/app/api/google/picker-token/route");
const call = () => POST(new NextRequest("https://x.test/api/google/picker-token", { method: "POST" }));

describe("POST /api/google/picker-token", () => {
  beforeEach(() => {
    m.user = { id: "u1" };
    m.env = { GOOGLE_PICKER_API_KEY: "dev-key", GOOGLE_PROJECT_NUMBER: "123456789012" };
    m.getGoogleAuth.mockReset();
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
    expect(Object.keys(body).sort()).toEqual(["accessToken", "appId", "developerKey", "expiresAt"]);
    expect(body).toEqual({ accessToken: "ya29.access", expiresAt: 1_900_000_000_000, developerKey: "dev-key", appId: "123456789012" });
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
});
