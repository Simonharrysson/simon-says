import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testEnv } from "@/test/env";

// In-memory cookie jar standing in for next/headers cookies().
type Jar = Map<string, { value: string; options?: Record<string, unknown> }>;
const jar = vi.hoisted(() => new Map() as Jar);
const sets = vi.hoisted(() => [] as { name: string; value: string; options?: Record<string, unknown> }[]);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      sets.push({ name, value, options });
      if (value === "" || options?.maxAge === 0) jar.delete(name);
      else jar.set(name, { value, options });
    },
  }),
}));

const google = vi.hoisted(() => ({
  storeGoogleToken: vi.fn(),
  hasGoogleToken: vi.fn(),
}));
vi.mock("@/lib/google/client", () => google);

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated", role: "authenticated" })}.sig`;
const user = { id: "u1", aud: "authenticated", email: "simon@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-11-24T00:00:00Z" };
const DRIVE = "openid https://www.googleapis.com/auth/drive.file";

let grantedScope = DRIVE;
let providerRefresh: string | undefined = "1//google-refresh";

beforeAll(() => {
  Object.assign(process.env, testEnv);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/token")) {
      return Response.json({
        access_token: jwt("u1"),
        refresh_token: "supabase-refresh",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
        provider_token: "ya29.google-access",
        ...(providerRefresh ? { provider_refresh_token: providerRefresh } : {}),
      });
    }
    if (url.includes("/auth/v1/user")) return Response.json(user);
    if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    if (url.includes("tokeninfo")) return Response.json({ scope: grantedScope });
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  });
});

beforeEach(() => {
  jar.clear();
  sets.length = 0;
  grantedScope = DRIVE;
  providerRefresh = "1//google-refresh";
  google.storeGoogleToken.mockReset().mockResolvedValue(undefined);
  google.hasGoogleToken.mockReset().mockResolvedValue(false);
  // PKCE verifier left by the login server action.
  jar.set("sb-example-auth-token-code-verifier", { value: JSON.stringify("verifier") });
});

const { GET } = await import("./route");

const call = () =>
  GET(new NextRequest("https://simonsays.example/auth/callback?code=abc", { headers: { host: "simonsays.example" } }));

const decode = (v: string) => (v.startsWith("base64-") ? Buffer.from(v.slice(7), "base64url").toString() : v);
const sessionCookies = () => [...jar].filter(([name]) => /^sb-example-auth-token(\.\d+)?$/.test(name));

describe("auth callback", () => {
  it("stores the Google token and leaves a session cookie without provider tokens, httpOnly", async () => {
    const res = await call();
    expect(res.headers.get("location")).toBe("https://simonsays.example/");
    expect(google.storeGoogleToken).toHaveBeenCalledWith("u1", "1//google-refresh", DRIVE);

    const session = sessionCookies();
    expect(session.length).toBeGreaterThan(0);
    for (const [, c] of session) expect(c.options?.httpOnly).toBe(true);
    const finalSession = session.map(([, c]) => decode(c.value)).join("");
    expect(finalSession).toContain("supabase-refresh");
    expect(finalSession).not.toContain("provider_");

    // Every cookie value written during the request, decoded, too: none carries Google tokens
    // once the response is built (the last write per name wins).
    const last = new Map(sets.map((s) => [s.name, s.value]));
    for (const value of last.values()) {
      expect(decode(value)).not.toContain("provider_");
      expect(decode(value)).not.toContain("google-refresh");
    }
  });

  it("redirects to /login?fel=kod and signs out when storing the token throws", async () => {
    google.storeGoogleToken.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.headers.get("location")).toBe("https://simonsays.example/login?fel=kod");
    expect(sessionCookies()).toEqual([]);
  });

  it("redirects to /login?fel=kod when hasGoogleToken throws", async () => {
    providerRefresh = undefined;
    google.hasGoogleToken.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.headers.get("location")).toBe("https://simonsays.example/login?fel=kod");
    expect(sessionCookies()).toEqual([]);
  });

  it("signs out and asks for drive.file when it wasn't granted", async () => {
    grantedScope = "openid email";
    const res = await call();
    expect(res.headers.get("location")).toBe("https://simonsays.example/login?fel=drive");
    expect(google.storeGoogleToken).not.toHaveBeenCalled();
    expect(sessionCookies()).toEqual([]);
  });
});
