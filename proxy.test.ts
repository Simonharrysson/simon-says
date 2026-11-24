import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testEnv } from "@/test/env";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, exp: number) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, exp, aud: "authenticated", role: "authenticated" })}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const user = { id: "u1", aud: "authenticated", email: "simon@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-11-24T00:00:00Z" };

let refreshed = 0;

beforeAll(() => {
  Object.assign(process.env, testEnv);
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/token") && url.includes("refresh_token")) {
      refreshed++;
      return Response.json({
        access_token: jwt("u1", now() + 3600),
        refresh_token: "new-refresh",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now() + 3600,
        user,
      });
    }
    if (url.includes("/auth/v1/user")) return Response.json(user);
    throw new Error(`unexpected fetch ${url}`);
  });
});

const { proxy } = await import("./proxy");

describe("proxy", () => {
  it("refreshes an expired session and writes the new cookie httpOnly", async () => {
    const expired = {
      access_token: jwt("u1", now() - 60),
      refresh_token: "old-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now() - 60,
      user,
    };
    const request = new NextRequest("https://simonsays.example/orgs", {
      headers: { cookie: `sb-example-auth-token=base64-${b64url(expired)}` },
    });
    const response = await proxy(request);

    expect(refreshed).toBe(1);
    const cookie = response.cookies.get("sb-example-auth-token");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    const value = cookie!.value;
    const session = Buffer.from(value.replace(/^base64-/, ""), "base64url").toString();
    expect(session).toContain("new-refresh");
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("passes through without a session", async () => {
    const response = await proxy(new NextRequest("https://simonsays.example/"));
    expect(response.cookies.getAll()).toEqual([]);
  });
});
