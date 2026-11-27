import { mcpDeps } from "@/lib/mcp/deps";
import { handleMcp } from "@/lib/mcp/handler";

// The Simon Says MCP server (docs/mcp.md): Streamable HTTP, stateless, OAuth Bearer tokens.
export const dynamic = "force-dynamic";
// prepare_agenda writes the agenda Doc (several Google batches).
export const maxDuration = 120;

export function POST(request: Request) {
  return handleMcp(request, mcpDeps());
}

// Stateless: no server-to-client stream (GET) and no session to end (DELETE).
const notAllowed = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });
export const GET = notAllowed;
export const DELETE = notAllowed;
