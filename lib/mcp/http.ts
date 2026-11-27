import type { Reply } from "./endpoints";

// Response helpers for the OAuth endpoints: JSON, never cached, open to any origin (no cookies are
// read there, and browser-based MCP clients call them cross-origin).

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function jsonReply(reply: Reply | { status: number; body: unknown }, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...CORS, ...headers },
  });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const notConfigured = () => jsonReply({ status: 503, body: { error: "temporarily_unavailable", error_description: "MCP is not configured" } });

/** An OAuth form body (application/x-www-form-urlencoded); JSON is accepted too. Null when unreadable. */
export async function formOf(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === "string") as [string, string][]);
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}
