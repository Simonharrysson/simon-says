import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testEnv } from "@/test/env";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, exp: number) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, exp, aud: "authenticated", role: "authenticated" })}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const user = { id: "u1", aud: "authenticated", email: "simon@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-11-24T00:00:00Z" };

let refreshed = 0;
const KNOWN_ORG = "11111111-1111-4111-8111-111111111111";

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
    if (url.includes("/rest/v1/orgs")) return Response.json(url.includes(KNOWN_ORG) ? [{ id: KNOWN_ORG }] : []);
    throw new Error(`unexpected fetch ${url}`);
  });
});

const { proxy, privatGuardedOrgId, isSignedInArea } = await import("./proxy");

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

  it("sends a signed-out visitor of the signed-in area to the login, keeping the way back", async () => {
    const response = await proxy(new NextRequest("https://simonsays.example/orgs/2b6c1c7e-9a4f-4f63-9d59-0c1b2a3d4e5f?flik=oversikt"));
    expect(response.status).toBe(307);
    const to = new URL(response.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/orgs/2b6c1c7e-9a4f-4f63-9d59-0c1b2a3d4e5f?flik=oversikt");
    const settings = await proxy(new NextRequest("https://simonsays.example/installningar"));
    expect(new URL(settings.headers.get("location")!).searchParams.get("next")).toBe("/installningar");
  });

  it("answers a real 404 for a förening the user can't see (documents only)", async () => {
    const valid = { access_token: jwt("u1", now() + 3600), refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: now() + 3600, user };
    const headers = { cookie: `sb-example-auth-token=base64-${b64url(valid)}`, "sec-fetch-dest": "document" };
    const unknown = await proxy(new NextRequest("https://simonsays.example/orgs/22222222-2222-4222-8222-222222222222", { headers }));
    expect(unknown.status).toBe(404);
    const notUuid = await proxy(new NextRequest("https://simonsays.example/orgs/finns-inte/forbered", { headers }));
    expect(notUuid.status).toBe(404);
    const known = await proxy(new NextRequest(`https://simonsays.example/orgs/${KNOWN_ORG}?flik=oversikt`, { headers }));
    expect(known.status).toBe(200);
  });

  it("passes through without a session", async () => {
    const response = await proxy(new NextRequest("https://simonsays.example/"));
    expect(response.cookies.getAll()).toEqual([]);
  });
});

describe("the Privat guard's paths", () => {
  const id = "1e2969d6-c2ba-435f-a1f9-56c89534609c";
  it("every /api/orgs/<id> route and every page below /orgs/<id>/, not /orgs/<id> itself", () => {
    expect(privatGuardedOrgId(`/api/orgs/${id}`)).toBe(id);
    expect(privatGuardedOrgId(`/api/orgs/${id}/history/import`)).toBe(id);
    expect(privatGuardedOrgId(`/orgs/${id}/protokoll`)).toBe(id);
    expect(privatGuardedOrgId(`/orgs/${id}/forbered`)).toBe(id);
    expect(privatGuardedOrgId(`/orgs/${id}`)).toBeNull();
    expect(privatGuardedOrgId(`/orgs/${id}/`)).toBeNull();
    expect(privatGuardedOrgId("/orgs")).toBeNull();
    expect(privatGuardedOrgId("/privat")).toBeNull();
    expect(privatGuardedOrgId(`/api/meetings/${id}`)).toBeNull();
  });
});

describe("the signed-in area", () => {
  it("covers Föreningar, Företag and Konto, not the public pages", () => {
    expect(isSignedInArea("/orgs")).toBe(true);
    expect(isSignedInArea("/foretag")).toBe(true);
    expect(isSignedInArea("/installningar")).toBe(true);
    expect(isSignedInArea("/foretagare")).toBe(false);
    expect(isSignedInArea("/login")).toBe(false);
  });
});
