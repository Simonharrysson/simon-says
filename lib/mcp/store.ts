import type { SupabaseClient } from "@supabase/supabase-js";

// The OAuth and audit tables (0060_mcp.sql) behind one interface, so the endpoints' rules are
// unit-tested against memoryStore() and run on the service role in production (dbStore). Nothing
// here ever reads meetings: tool data goes through the mcp_* functions (lib/mcp/reader.ts).

export interface ClientRow {
  id: string;
  client_name: string;
  redirect_uris: string[];
}

export interface AuthRequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  resource: string;
  expires_at: string;
}

export interface CodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: string;
}

export interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  resource: string;
  revoked_at: string | null;
  /** The redirect URI of the latest approval (0068): Konto names the app from it. */
  redirect_uri?: string | null;
}

export interface AuditRow {
  user_id: string;
  grant_id: string;
  tool: string;
  ids: Record<string, string>;
  ok: boolean;
}

export interface McpStore {
  createClient(row: ClientRow): Promise<void>;
  getClient(id: string): Promise<ClientRow | null>;
  createRequest(row: AuthRequestRow): Promise<void>;
  getRequest(id: string): Promise<AuthRequestRow | null>;
  /** Single use: the row, deleted; null when it was not there. */
  takeRequest(id: string): Promise<AuthRequestRow | null>;
  createCode(row: CodeRow): Promise<void>;
  /** Single use: the row, deleted; null when it was not there (or already taken). */
  takeCode(hash: string): Promise<CodeRow | null>;
  /** The user's active grant for this client (reused on reconnect), else a new one; either way it records `redirectUri`. */
  grantFor(userId: string, client: ClientRow, resource: string, redirectUri: string): Promise<string>;
  getGrant(id: string): Promise<GrantRow | null>;
  addTokens(grantId: string, tokens: { hash: string; kind: "access" | "refresh"; expiresAt: string }[]): Promise<void>;
  /** Spend a refresh token once: its grant, `reused` when it had been spent before; null when unknown or expired. */
  spendRefresh(hash: string): Promise<{ grantId: string; reused: boolean } | null>;
  /** The grant behind a live access token, or null. */
  grantForAccess(hash: string, now: Date): Promise<GrantRow | null>;
  revokeGrant(id: string): Promise<void>;
  /** The grant of any token (access or refresh) the client presents, for revocation. */
  grantOfToken(hash: string): Promise<string | null>;
  touchGrant(id: string): Promise<void>;
  /** One hit on `key`; false when over `limit` in the current `seconds` window. */
  rateTake(key: string, limit: number, seconds: number): Promise<boolean>;
  audit(row: AuditRow): Promise<void>;
}

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`mcp store: ${what}: ${error.message}`);
};

/** The real store on the service-role client. */
export function dbStore(admin: SupabaseClient): McpStore {
  return {
    async createClient(row) {
      const { error } = await admin.from("mcp_clients").insert(row);
      if (error) fail("client insert", error);
    },
    async getClient(id) {
      const { data, error } = await admin.from("mcp_clients").select("id, client_name, redirect_uris").eq("id", id).maybeSingle();
      if (error) fail("client", error);
      return (data as ClientRow | null) ?? null;
    },
    async createRequest(row) {
      const { error } = await admin.from("mcp_auth_requests").insert(row);
      if (error) fail("request insert", error);
    },
    async getRequest(id) {
      const { data, error } = await admin
        .from("mcp_auth_requests")
        .select("id, client_id, redirect_uri, code_challenge, state, resource, expires_at")
        .eq("id", id)
        .maybeSingle();
      if (error) fail("request", error);
      return (data as AuthRequestRow | null) ?? null;
    },
    async takeRequest(id) {
      const { data, error } = await admin
        .from("mcp_auth_requests")
        .delete()
        .eq("id", id)
        .select("id, client_id, redirect_uri, code_challenge, state, resource, expires_at");
      if (error) fail("request take", error);
      return ((data ?? [])[0] as AuthRequestRow | undefined) ?? null;
    },
    async createCode(row) {
      const { error } = await admin.from("mcp_auth_codes").insert(row);
      if (error) fail("code insert", error);
    },
    async takeCode(hash) {
      const { data, error } = await admin
        .from("mcp_auth_codes")
        .delete()
        .eq("code_hash", hash)
        .select("code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at");
      if (error) fail("code take", error);
      return ((data ?? [])[0] as CodeRow | undefined) ?? null;
    },
    async grantFor(userId, client, resource, redirectUri) {
      const { data, error } = await admin
        .from("mcp_grants")
        .select("id")
        .eq("user_id", userId)
        .eq("client_id", client.id)
        .eq("resource", resource)
        .is("revoked_at", null)
        .limit(1);
      if (error) fail("grant lookup", error);
      if (data?.length) {
        const id = data[0].id as string;
        const { error: e3 } = await admin.from("mcp_grants").update({ redirect_uri: redirectUri }).eq("id", id);
        if (e3) fail("grant redirect", e3);
        return id;
      }
      const { data: row, error: e2 } = await admin
        .from("mcp_grants")
        .insert({ user_id: userId, client_id: client.id, client_name: client.client_name, resource, redirect_uri: redirectUri })
        .select("id")
        .single();
      if (e2) fail("grant insert", e2);
      return row!.id as string;
    },
    async getGrant(id) {
      const { data, error } = await admin.from("mcp_grants").select("id, user_id, client_id, client_name, resource, revoked_at").eq("id", id).maybeSingle();
      if (error) fail("grant", error);
      return (data as GrantRow | null) ?? null;
    },
    async addTokens(grantId, tokens) {
      const { error } = await admin
        .from("mcp_tokens")
        .insert(tokens.map((t) => ({ token_hash: t.hash, grant_id: grantId, kind: t.kind, expires_at: t.expiresAt })));
      if (error) fail("tokens insert", error);
    },
    async spendRefresh(hash) {
      const { data, error } = await admin.rpc("mcp_spend_refresh", { p_hash: hash });
      if (error) fail("spend refresh", error);
      const row = ((data ?? []) as { grant_id: string; reused: boolean }[])[0];
      return row ? { grantId: row.grant_id, reused: row.reused } : null;
    },
    async grantForAccess(hash, now) {
      const { data, error } = await admin
        .from("mcp_tokens")
        .select("expires_at, mcp_grants!inner(id, user_id, client_id, client_name, resource, revoked_at)")
        .eq("token_hash", hash)
        .eq("kind", "access")
        .maybeSingle();
      if (error) fail("access", error);
      if (!data) return null;
      const grant = (data as unknown as { expires_at: string; mcp_grants: GrantRow }).mcp_grants;
      if (Date.parse(data.expires_at as string) <= now.getTime() || grant.revoked_at) return null;
      return grant;
    },
    async revokeGrant(id) {
      const { error } = await admin.from("mcp_grants").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
      if (error) fail("revoke", error);
      const { error: e2 } = await admin.from("mcp_tokens").delete().eq("grant_id", id);
      if (e2) fail("revoke tokens", e2);
    },
    async grantOfToken(hash) {
      const { data, error } = await admin.from("mcp_tokens").select("grant_id").eq("token_hash", hash).maybeSingle();
      if (error) fail("token grant", error);
      return (data?.grant_id as string | undefined) ?? null;
    },
    async touchGrant(id) {
      const { error } = await admin.from("mcp_grants").update({ last_used_at: new Date().toISOString() }).eq("id", id);
      if (error) fail("touch", error);
    },
    async rateTake(key, limit, seconds) {
      const { data, error } = await admin.rpc("mcp_rate_take", { p_key: key, p_limit: limit, p_seconds: seconds });
      if (error) fail("rate", error);
      return data === true;
    },
    async audit(row) {
      const { error } = await admin.from("mcp_audit").insert(row);
      if (error) fail("audit", error);
    },
  };
}

/** An in-memory store with the same semantics, for unit tests. */
export function memoryStore() {
  const clients = new Map<string, ClientRow>();
  const requests = new Map<string, AuthRequestRow>();
  const codes = new Map<string, CodeRow>();
  const grants = new Map<string, GrantRow>();
  const tokens = new Map<string, { grant_id: string; kind: "access" | "refresh"; expires_at: string; used_at: string | null }>();
  const rate = new Map<string, number>();
  const audits: AuditRow[] = [];
  let n = 0;
  const take = <T>(m: Map<string, T>, k: string) => {
    const v = m.get(k) ?? null;
    m.delete(k);
    return v;
  };
  const store: McpStore = {
    async createClient(row) {
      clients.set(row.id, row);
    },
    async getClient(id) {
      return clients.get(id) ?? null;
    },
    async createRequest(row) {
      requests.set(row.id, row);
    },
    async getRequest(id) {
      return requests.get(id) ?? null;
    },
    async takeRequest(id) {
      return take(requests, id);
    },
    async createCode(row) {
      codes.set(row.code_hash, row);
    },
    async takeCode(hash) {
      return take(codes, hash);
    },
    async grantFor(userId, client, resource, redirectUri) {
      for (const g of grants.values()) {
        if (g.user_id === userId && g.client_id === client.id && g.resource === resource && !g.revoked_at) {
          g.redirect_uri = redirectUri;
          return g.id;
        }
      }
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      grants.set(id, { id, user_id: userId, client_id: client.id, client_name: client.client_name, resource, revoked_at: null, redirect_uri: redirectUri });
      return id;
    },
    async getGrant(id) {
      return grants.get(id) ?? null;
    },
    async addTokens(grantId, list) {
      for (const t of list) tokens.set(t.hash, { grant_id: grantId, kind: t.kind, expires_at: t.expiresAt, used_at: null });
    },
    async spendRefresh(hash) {
      const t = tokens.get(hash);
      if (!t || t.kind !== "refresh") return null;
      if (t.used_at) return { grantId: t.grant_id, reused: true };
      if (Date.parse(t.expires_at) <= Date.now()) return null;
      t.used_at = new Date().toISOString();
      return { grantId: t.grant_id, reused: false };
    },
    async grantForAccess(hash, now) {
      const t = tokens.get(hash);
      if (!t || t.kind !== "access" || Date.parse(t.expires_at) <= now.getTime()) return null;
      const g = grants.get(t.grant_id);
      return g && !g.revoked_at ? g : null;
    },
    async revokeGrant(id) {
      const g = grants.get(id);
      if (g && !g.revoked_at) g.revoked_at = new Date().toISOString();
      for (const [h, t] of tokens) if (t.grant_id === id) tokens.delete(h);
    },
    async grantOfToken(hash) {
      return tokens.get(hash)?.grant_id ?? null;
    },
    async touchGrant() {},
    async rateTake(key, limit) {
      const hits = (rate.get(key) ?? 0) + 1;
      rate.set(key, hits);
      return hits <= limit;
    },
    async audit(row) {
      audits.push(row);
    },
  };
  return { store, clients, requests, codes, grants, tokens, audits };
}
