import { mcpConfigured } from "@/lib/mcp/deps";
import { jsonReply, notConfigured, preflight } from "@/lib/mcp/http";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { appOrigin } from "@/lib/origin";

// RFC 8414 Authorization Server Metadata: Simon Says authorizes its own MCP server.
export const dynamic = "force-dynamic";

export function GET() {
  if (!mcpConfigured()) return notConfigured();
  return jsonReply({ status: 200, body: authorizationServerMetadata(appOrigin()) }, { "cache-control": "public, max-age=3600" });
}

export const OPTIONS = preflight;
