import "server-only";
import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { McpDeps } from "./handler";
import { dbReader } from "./reader";
import { dbStore, type McpStore } from "./store";
import { defaultToolDeps } from "./tools";

// The production wiring of the MCP server and its authorization endpoints.

export function mcpStore(): McpStore {
  return dbStore(supabaseAdmin());
}

/** MCP is on (MCP_ENABLED, default on): every endpoint answers 503 when it is off. */
export function mcpConfigured(): boolean {
  return getEnv().MCP_ENABLED;
}

export function mcpDeps(): McpDeps {
  return {
    origin: appOrigin(),
    store: mcpStore(),
    reader: (userId) => dbReader(supabaseAdmin(), userId),
    loadUser: async (userId) => {
      const { data, error } = await supabaseAdmin().auth.admin.getUserById(userId);
      if (error || !data.user) return null;
      return data.user;
    },
    enabled: mcpConfigured,
    toolDeps: defaultToolDeps,
  };
}

/** A per-IP rate key that never stores the address itself. */
export function ipKey(request: Request, scope: string): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}
