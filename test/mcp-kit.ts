import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { approve, authorize, register, revoke, token } from "@/lib/mcp/endpoints";
import { handleMcp, type McpDeps } from "@/lib/mcp/handler";
import { authorizationServerMetadata, protectedResourceMetadata } from "@/lib/mcp/oauth";

// The MCP SDK client against our endpoints, in-process: a fetch that routes each URL to the same
// functions the app's route handlers call (app/.well-known/*, app/api/oauth/*, app/oauth/authorize,
// app/api/mcp). No network, no Google: "approval" is approve() for a given user id.

export const ORIGIN = "https://simonsays.test";
export const MCP_URL = `${ORIGIN}/api/mcp`;
const REDIRECT = "http://127.0.0.1:33418/callback";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function routerFetch(deps: McpDeps): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error(`unexpected fetch ${url.origin}`);
    const path = url.pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource")) return json(200, protectedResourceMetadata(ORIGIN));
    if (path === "/.well-known/oauth-authorization-server") return json(200, authorizationServerMetadata(ORIGIN));
    if (path.startsWith("/.well-known/")) return json(404, {});
    if (path === "/api/oauth/register") {
      const r = await register(await request.json(), deps.store);
      return json(r.status, r.body);
    }
    if (path === "/api/oauth/token") {
      const r = await token(new URLSearchParams(await request.text()), deps.store, ORIGIN);
      return json(r.status, r.body);
    }
    if (path === "/api/oauth/revoke") {
      const r = await revoke(new URLSearchParams(await request.text()), deps.store);
      return json(r.status, r.body);
    }
    if (path === "/api/mcp") return request.method === "POST" ? handleMcp(request, deps) : new Response(null, { status: 405 });
    return json(404, {});
  }) as typeof fetch;
}

/** A Claude-like OAuth client that keeps everything in memory. */
export class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authUrl: URL | undefined;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: "Claude (test)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    return "st-123";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/**
 * The whole connector flow for `userId`: the 401 → discovery → DCR → authorize → consent
 * (approve) → code exchange → a connected SDK client.
 */
export async function connectAs(userId: string, deps: McpDeps): Promise<{ client: Client; provider: MemoryProvider }> {
  const fetchFn = routerFetch(deps);
  const provider = new MemoryProvider();
  const first = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: fetchFn });
  const probe = new Client({ name: "test", version: "1" });
  await probe.connect(first).then(
    () => {
      throw new Error("expected 401 before authorization");
    },
    (err) => {
      if (!(err instanceof UnauthorizedError)) throw err;
    },
  );
  if (!provider.authUrl) throw new Error("no authorization URL");
  const outcome = await authorize(provider.authUrl.searchParams, deps.store, ORIGIN);
  if (outcome.kind !== "consent") throw new Error(`authorize: ${JSON.stringify(outcome)}`);
  const back = await approve(outcome.requestId, userId, deps.store, ORIGIN);
  if (!back) throw new Error("approve failed");
  const cb = new URL(back);
  if (cb.searchParams.get("state") !== "st-123" || cb.searchParams.get("iss") !== ORIGIN) throw new Error("state/iss not returned");
  await first.finishAuth(cb.searchParams.get("code")!);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: fetchFn }));
  return { client, provider };
}

/** A tool call's text, parsed when it is JSON. */
export function resultOf(r: unknown): { isError: boolean; data: unknown; text: string } {
  const res = r as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content[0]?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: Boolean(res.isError), data, text };
}

/** A reader with fixed rows (unit tests): everything empty unless given. */
export function fakeReader(userId: string, over: Partial<import("@/lib/mcp/reader").McpReader> = {}): import("@/lib/mcp/reader").McpReader {
  return {
    userId,
    orgs: async () => [],
    meetings: async () => [],
    noteItems: async () => [],
    people: async () => [],
    contexts: async () => [],
    privateSummaries: async () => [],
    contextTasks: async () => [],
    handoffs: async () => [],
    setHandoffDone: async () => false,
    setPrivatTaskDone: async () => false,
    ...over,
  };
}
