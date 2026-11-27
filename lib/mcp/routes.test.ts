import type { User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { fakeReader, MCP_URL, MemoryProvider, ORIGIN, resultOf } from "@/test/mcp-kit";
import type { McpDeps } from "./handler";
import { memoryStore } from "./store";

// The SDK client against the app's real route handlers (app/.well-known/*, app/api/oauth/*,
// app/oauth/authorize, app/api/mcp), in-process: only the wiring (lib/mcp/deps.ts) is swapped for
// a memory store and a test user. Consent is approve() for that user (the /koppla page's action).

const USER = { id: "77777777-7777-4777-8777-777777777777", email: "simon@example.com" } as User;
const mem = vi.hoisted(() => ({ deps: null as unknown as McpDeps }));

vi.mock("@/lib/origin", () => ({ appOrigin: () => "https://simonsays.test" }));
vi.mock("@/lib/mcp/deps", () => ({
  mcpConfigured: () => true,
  mcpStore: () => mem.deps.store,
  mcpDeps: () => mem.deps,
  ipKey: (_r: Request, scope: string) => `${scope}:test`,
}));

const routes = {
  "/.well-known/oauth-protected-resource": await import("@/app/.well-known/oauth-protected-resource/route"),
  "/.well-known/oauth-protected-resource/api/mcp": await import("@/app/.well-known/oauth-protected-resource/api/mcp/route"),
  "/.well-known/oauth-authorization-server": await import("@/app/.well-known/oauth-authorization-server/route"),
  "/api/oauth/register": await import("@/app/api/oauth/register/route"),
  "/api/oauth/token": await import("@/app/api/oauth/token/route"),
  "/api/oauth/revoke": await import("@/app/api/oauth/revoke/route"),
  "/oauth/authorize": await import("@/app/oauth/authorize/route"),
  "/api/mcp": await import("@/app/api/mcp/route"),
} as Record<string, Record<string, unknown>>;
const { approve } = await import("./endpoints");

const routeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new NextRequest(new Request(input, init));
  const mod = routes[request.nextUrl.pathname];
  const handler = mod?.[request.method] as ((r: NextRequest) => Response | Promise<Response>) | undefined;
  return handler ? handler(request) : new Response("{}", { status: 404 });
}) as typeof fetch;

describe("the SDK client against the route handlers", () => {
  it("connects through discovery, DCR, /oauth/authorize, consent and the token route, then calls tools", async () => {
    const m = memoryStore();
    mem.deps = {
      origin: ORIGIN,
      store: m.store,
      reader: (userId) => fakeReader(userId, { setHandoffDone: async () => true }),
      loadUser: async (id) => (id === USER.id ? USER : null),
      enabled: () => true,
      toolDeps: {} as McpDeps["toolDeps"],
    };
    const provider = new MemoryProvider();
    const first = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: routeFetch });
    await expect(new Client({ name: "t", version: "1" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toMatch(/^ssk_/);

    // The browser step: /oauth/authorize redirects to the consent page; Godkänn → back to Claude.
    const res = await routeFetch(provider.authUrl!.toString());
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get("location")!);
    expect(consent.pathname).toMatch(/^\/koppla\/ssq_/);
    const back = new URL((await approve(consent.pathname.split("/")[2], USER.id, m.store, ORIGIN))!);
    await first.finishAuth(back.searchParams.get("code")!);

    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: routeFetch }));
    expect((await client.listTools()).tools).toHaveLength(6);
    const r = resultOf(await client.callTool({ name: "complete_task", arguments: { task_id: "h:33333333-3333-4333-8333-333333333333" } }));
    expect(r.data).toMatchObject({ done: true });
    await client.close();

    // GET is not part of a stateless server; revoke ends the token.
    expect((await routeFetch(MCP_URL)).status).toBe(405);
    const revoked = await routeFetch(`${ORIGIN}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: provider.saved!.access_token }) });
    expect(revoked.status).toBe(200);
    const after = await routeFetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${provider.saved!.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
  });
});
