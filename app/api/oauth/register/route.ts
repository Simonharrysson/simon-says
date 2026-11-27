import { ipKey, mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { register } from "@/lib/mcp/endpoints";
import { jsonReply, notConfigured, preflight } from "@/lib/mcp/http";

// RFC 7591 Dynamic Client Registration (public clients only), rate-limited per client IP.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!mcpConfigured()) return notConfigured();
  const store = mcpStore();
  if (!(await store.rateTake(ipKey(request, "register"), 20, 600))) {
    return jsonReply({ status: 429, body: { error: "too_many_requests" } }, { "retry-after": "600" });
  }
  const body = await request.json().catch(() => null);
  return jsonReply(await register(body, store));
}

export const OPTIONS = preflight;
