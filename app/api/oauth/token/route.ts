import { ipKey, mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { token } from "@/lib/mcp/endpoints";
import { formOf, jsonReply, notConfigured, preflight } from "@/lib/mcp/http";
import { appOrigin } from "@/lib/origin";

// The token endpoint: authorization_code (PKCE S256) and refresh_token (rotated; reuse revokes).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!mcpConfigured()) return notConfigured();
  const store = mcpStore();
  if (!(await store.rateTake(ipKey(request, "token"), 60, 600))) {
    return jsonReply({ status: 429, body: { error: "too_many_requests" } }, { "retry-after": "600" });
  }
  const form = await formOf(request);
  if (!form) return jsonReply({ status: 400, body: { error: "invalid_request" } });
  return jsonReply(await token(form, store, appOrigin()));
}

export const OPTIONS = preflight;
