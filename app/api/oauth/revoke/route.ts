import { mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { revoke } from "@/lib/mcp/endpoints";
import { formOf, jsonReply, notConfigured, preflight } from "@/lib/mcp/http";

// RFC 7009 token revocation: ends the token's whole grant (the connection). Always 200.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!mcpConfigured()) return notConfigured();
  const form = await formOf(request);
  if (!form) return jsonReply({ status: 400, body: { error: "invalid_request" } });
  return jsonReply(await revoke(form, mcpStore()));
}

export const OPTIONS = preflight;
