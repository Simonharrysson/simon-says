import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

// The MCP server's OAuth 2.1 pieces that need no database: the metadata documents, token minting
// and hashing, PKCE S256, redirect-URI rules (docs/superpowers/specs/2026-11-27-mcp-design.md).
// Pure, so every rule is unit-tested without a stack.

export const SCOPE = "meetings";
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
export const CODE_TTL_S = 60;
export const REQUEST_TTL_S = 10 * 60;

/** This server's canonical resource URI (RFC 8707): the MCP endpoint, no trailing slash. */
export const resourceUri = (origin: string) => `${origin}/api/mcp`;

export function protectedResourceMetadata(origin: string): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUri(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Simon Says",
    resource_documentation: `${origin}/integritet`,
  };
}

export function authorizationServerMetadata(origin: string): OAuthMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** The 401 challenge (RFC 9728 §5.1): where the metadata is and which scope to ask for. */
export function bearerChallenge(origin: string, error?: "invalid_token"): string {
  const parts = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`, `scope="${SCOPE}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// Tokens: opaque, 32 random bytes, only their SHA-256 is stored.

export type TokenKind = "access" | "refresh" | "code" | "client" | "request";
const PREFIX: Record<TokenKind, string> = { access: "ssa_", refresh: "ssr_", code: "ssc_", client: "ssk_", request: "ssq_" };

export function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A token of `kind` by its shape only (cheap pre-check before a lookup). */
export function looksLike(kind: TokenKind, value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(PREFIX[kind]) && /^[A-Za-z0-9_-]{43}$/.test(value.slice(4));
}

/** `Authorization: Bearer <token>` → the token, or null. Never logged. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header?.trim() ?? "");
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// PKCE: S256 only (OAuth 2.1; "plain" is refused at authorize).

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const validVerifier = (v: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
/** A S256 challenge: base64url of 32 bytes. */
export const validChallenge = (c: string) => /^[A-Za-z0-9_-]{43}$/.test(c);

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!validVerifier(verifier) || !validChallenge(challenge)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

// ---------------------------------------------------------------------------------------------
// Redirect URIs.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** May a client register this redirect URI? https anywhere, http only on loopback; no fragment, no credentials. */
export function registrableRedirect(uri: string): boolean {
  if (typeof uri !== "string" || uri.length > 500 || !URL.canParse(uri)) return false;
  const u = new URL(uri);
  if (u.hash || uri.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/**
 * The requested redirect URI against a registered one: exact, except that a loopback URI may use
 * any port (RFC 8252 §7.3, native clients such as Claude Code pick an ephemeral port).
 */
export function redirectMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  if (!URL.canParse(requested) || !URL.canParse(registered)) return false;
  const a = new URL(requested);
  const b = new URL(registered);
  if (!LOOPBACK.has(a.hostname) || !LOOPBACK.has(b.hostname)) return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && !a.hash;
}

/** `resource` as sent (RFC 8707): absent, or this server's resource (scheme and host case-insensitive, one trailing slash aside). */
export function resourceMatches(sent: string | null | undefined, origin: string): boolean {
  if (sent === null || sent === undefined || sent === "") return true;
  if (!URL.canParse(sent)) return false;
  const u = new URL(sent);
  if (u.hash || u.search) return false;
  const expected = new URL(resourceUri(origin));
  return u.origin === expected.origin && u.pathname.replace(/\/$/, "") === expected.pathname;
}

/** `redirect_uri` + the response parameters (code, or error), state and iss (RFC 9207). */
export function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// Dynamic client registration (RFC 7591): public clients only.

export interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
}

export type RegistrationResult = { ok: true; value: ClientRegistration } | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

export function parseRegistration(body: unknown): RegistrationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris: 1 to 5 URIs." };
  }
  if (!uris.every((u) => registrableRedirect(u as string))) {
    return { ok: false, error: "invalid_redirect_uri", description: "Redirect URIs must be https, or http on a loopback host." };
  }
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return { ok: false, error: "invalid_client_metadata", description: "Only public clients (token_endpoint_auth_method none)." };
  }
  for (const [field, allowed] of [
    ["grant_types", ["authorization_code", "refresh_token"]],
    ["response_types", ["code"]],
  ] as const) {
    const v = b[field];
    if (v !== undefined && (!Array.isArray(v) || !v.every((x) => (allowed as readonly string[]).includes(x as string)))) {
      return { ok: false, error: "invalid_client_metadata", description: `${field}: only ${allowed.join(", ")}.` };
    }
  }
  const rawName = typeof b.client_name === "string" ? b.client_name : "";
  // A name is shown on the consent page and in Konto: one plain line.
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "AI-assistent";
  return { ok: true, value: { client_name: name, redirect_uris: [...new Set(uris as string[])] } };
}

// ---------------------------------------------------------------------------------------------
// DNS rebinding (MCP transport spec): a browser request must come from a known origin.

export function allowedOrigin(origin: string | null, appOrigin: string): boolean {
  if (origin === null) return true;
  return [appOrigin, "https://claude.ai", "https://claude.com"].includes(origin);
}
