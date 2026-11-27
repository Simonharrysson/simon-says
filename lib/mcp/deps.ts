import "server-only";
import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import { canCreateForetag } from "@/lib/foretag/gate";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { McpDeps } from "./handler";
import { dbStore, type McpStore } from "./store";
import { defaultToolDeps } from "./tools";

// The production wiring of the MCP server and its authorization endpoints.

export function mcpStore(): McpStore {
  return dbStore(supabaseAdmin());
}

/** MCP is configured (SUPABASE_JWT_SECRET set); every endpoint answers 503 otherwise. */
export function mcpConfigured(): boolean {
  return Boolean(getEnv().SUPABASE_JWT_SECRET);
}

export function mcpDeps(): McpDeps {
  const env = getEnv();
  return {
    origin: appOrigin(),
    supabaseUrl: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    store: mcpStore(),
    loadUser: async (userId) => {
      const { data, error } = await supabaseAdmin().auth.admin.getUserById(userId);
      if (error || !data.user) return null;
      return data.user;
    },
    // The same allow-list as creating a Företag, until MCP is tested (spec "Gate").
    allowed: canCreateForetag,
    toolDeps: defaultToolDeps,
  };
}

/** A per-IP rate key that never stores the address itself. */
export function ipKey(request: Request, scope: string): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}
