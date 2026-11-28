import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appOfRedirect, loadConnections } from "./account";

/** A user-scoped client that answers the two reads loadConnections makes. */
function fakeDb(grants: Record<string, unknown>[]): SupabaseClient {
  const result = (data: unknown) => ({ data, error: null });
  const chain = (data: unknown) => {
    const q = { select: () => q, is: () => q, order: () => q, limit: () => Promise.resolve(result(data)), then: (f: (v: unknown) => unknown) => Promise.resolve(result(data)).then(f) };
    return q;
  };
  return { from: (table: string) => chain(table === "mcp_grants" ? grants : []) } as unknown as SupabaseClient;
}

describe("Konto's connected list: the app comes from the redirect URI, never the client's name", () => {
  it("a client calling itself ChatGPT on a loopback redirect is a local app, not ChatGPT", async () => {
    const { connections } = await loadConnections(
      fakeDb([{ id: "g1", client_name: "ChatGPT", created_at: "2026-11-28T10:00:00Z", last_used_at: null, redirect_uri: "http://127.0.0.1:5000/callback" }]),
    );
    expect(connections).toEqual([{ id: "g1", client_name: "ChatGPT", created_at: "2026-11-28T10:00:00Z", last_used_at: null, app: "local" }]);
  });
  it("maps each documented callback, and nothing recorded to unknown", () => {
    expect(appOfRedirect("https://claude.ai/api/mcp/auth_callback")).toBe("claude");
    expect(appOfRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe("chatgpt");
    expect(appOfRedirect("https://www.cursor.com/agents/mcp/oauth/callback")).toBe("cursor");
    expect(appOfRedirect("https://vscode.dev/redirect")).toBe("vscode");
    expect(appOfRedirect("http://localhost:8787/callback")).toBe("local");
    expect(appOfRedirect(null)).toBe("unknown");
    expect(appOfRedirect("https://evil.example/cb")).toBe("unknown");
  });
});
