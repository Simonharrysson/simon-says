import { mcpConfigured } from "@/lib/mcp/deps";
import { jsonReply, notConfigured, preflight } from "@/lib/mcp/http";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { appOrigin } from "@/lib/origin";

// RFC 9728 Protected Resource Metadata for the MCP server (/api/mcp).
export const dynamic = "force-dynamic";

export function GET() {
  if (!mcpConfigured()) return notConfigured();
  return jsonReply({ status: 200, body: protectedResourceMetadata(appOrigin()) }, { "cache-control": "public, max-age=3600" });
}

export const OPTIONS = preflight;
