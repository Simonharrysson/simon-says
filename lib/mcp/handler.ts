import "server-only";
import type { User } from "@supabase/supabase-js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { allowedOrigin, bearerChallenge, bearerToken, hashToken, looksLike, resourceUri } from "./oauth";
import { buildServer } from "./server";
import type { McpStore } from "./store";
import type { ToolDeps } from "./tools";
import type { McpReader } from "./reader";

// POST /api/mcp: authenticate the Bearer token, check the allow-list and the rate limit, then run
// one stateless MCP exchange as the user. Every refusal before the transport is plain HTTP (401
// with the RFC 9728 challenge, 403, 429, 503); the token itself is never logged.

/** Calls per minute per user, across all their connected assistants. */
export const RATE_PER_MINUTE = 60;

export interface McpDeps {
  origin: string;
  store: McpStore;
  /** The user's reads (the mcp_* functions of 0060, for this user only). */
  reader: (userId: string) => McpReader;
  /** The user behind a grant, freshly loaded (null: deleted). */
  loadUser: (userId: string) => Promise<User | null>;
  /** The kill switch (MCP_ENABLED): off answers 503 for every token. */
  enabled: () => boolean;
  toolDeps: ToolDeps;
  now?: () => Date;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (!deps.enabled()) return json(503, { error: "temporarily_unavailable", error_description: "Simon Says for Claude is turned off right now." });
  if (!allowedOrigin(request.headers.get("origin"), deps.origin)) return json(403, { error: "origin_not_allowed" });

  const unauthorized = (error?: "invalid_token") =>
    json(401, { error: error ?? "unauthorized", error_description: "Connect Simon Says again." }, { "www-authenticate": bearerChallenge(deps.origin, error) });
  const raw = bearerToken(request.headers.get("authorization"));
  if (!raw) return unauthorized();
  if (!looksLike("access", raw)) return unauthorized("invalid_token");

  const now = deps.now?.() ?? new Date();
  let grant;
  try {
    grant = await deps.store.grantForAccess(hashToken(raw), now);
  } catch (err) {
    console.error(`mcp: token lookup: ${(err as Error).message}`);
    return json(503, { error: "temporarily_unavailable" });
  }
  // Audience: a token is only good for this server's resource.
  if (!grant || grant.resource !== resourceUri(deps.origin)) return unauthorized("invalid_token");
  const user = await deps.loadUser(grant.user_id);
  if (!user) return unauthorized("invalid_token");
  // Per user (every connection of theirs together), so more connections never mean more calls.
  if (!(await deps.store.rateTake(`user:${user.id}`, RATE_PER_MINUTE, 60))) {
    return json(429, { error: "rate_limited", error_description: `At most ${RATE_PER_MINUTE} calls a minute.` }, { "retry-after": "60" });
  }
  deps.store.touchGrant(grant.id).catch((err) => console.error(`mcp: touch: ${(err as Error).message}`));

  const server = buildServer({ reader: deps.reader(user.id), user, deps: deps.toolDeps, now }, { store: deps.store, grantId: grant.id });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { authInfo: { token: "", clientId: grant.client_id, scopes: ["meetings"], resource: new URL(grant.resource), extra: { userId: user.id } } });
  } catch (err) {
    console.error(`mcp: request failed: ${(err as Error).message}`);
    return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally {
    // JSON mode: the response is complete once handleRequest returned.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
