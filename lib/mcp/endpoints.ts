import {
  ACCESS_TTL_S,
  CODE_TTL_S,
  hashToken,
  looksLike,
  newToken,
  parseRegistration,
  REFRESH_TTL_S,
  REQUEST_TTL_S,
  redirectMatches,
  redirectWith,
  resourceMatches,
  resourceUri,
  SCOPE,
  validChallenge,
  verifyPkce,
} from "./oauth";
import type { McpStore } from "./store";

// The authorization server's endpoints as plain functions over a store (the routes in
// app/api/oauth/* and app/oauth/authorize are thin wrappers). OAuth errors are RFC 6749 §5.2
// shaped; a token, code or verifier is never put into an error or a log line.

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const oauthError = (status: number, error: string, description?: string): Reply => ({
  status,
  body: description ? { error, error_description: description } : { error },
});

const iso = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

// ---------------------------------------------------------------------------------------------
// POST /api/oauth/register (RFC 7591)

export async function register(body: unknown, store: McpStore, now = new Date()): Promise<Reply> {
  const parsed = parseRegistration(body);
  if (!parsed.ok) return oauthError(400, parsed.error, parsed.description);
  const id = newToken("client");
  await store.createClient({ id, ...parsed.value });
  return {
    status: 201,
    body: {
      client_id: id,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: parsed.value.client_name,
      redirect_uris: parsed.value.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// GET /oauth/authorize

export type AuthorizeOutcome =
  /** Never redirect: the client or its redirect URI is unknown (open-redirect rule). */
  | { kind: "error_page"; reason: "unknown_client" | "bad_redirect" }
  /** Back to the client with an OAuth error. */
  | { kind: "redirect"; url: string }
  /** Valid: the consent page for this stored request. */
  | { kind: "consent"; requestId: string };

export async function authorize(params: URLSearchParams, store: McpStore, origin: string, now = new Date()): Promise<AuthorizeOutcome> {
  const clientId = params.get("client_id") ?? "";
  const client = looksLike("client", clientId) ? await store.getClient(clientId) : null;
  if (!client) return { kind: "error_page", reason: "unknown_client" };
  const asked = params.get("redirect_uri");
  let redirectUri: string;
  if (asked) {
    if (!client.redirect_uris.some((r) => redirectMatches(asked, r))) return { kind: "error_page", reason: "bad_redirect" };
    redirectUri = asked;
  } else if (client.redirect_uris.length === 1) {
    redirectUri = client.redirect_uris[0];
  } else {
    return { kind: "error_page", reason: "bad_redirect" };
  }
  const state = params.get("state");
  const back = (error: string, description: string) => ({
    kind: "redirect" as const,
    url: redirectWith(redirectUri, { error, error_description: description, state, iss: origin }),
  });
  if (state !== null && state.length > 500) return back("invalid_request", "state too long");
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "response_type must be code");
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !validChallenge(challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method S256 is required");
  }
  // Any requested scope is answered with the one scope there is (`meetings`): RFC 6749 §3.3 lets the
  // server grant a different scope, and clients differ in what they ask for.
  if (!resourceMatches(params.get("resource"), origin)) return back("invalid_target", "resource is not this server");
  const id = newToken("request");
  await store.createRequest({
    id,
    client_id: client.id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
    resource: resourceUri(origin),
    expires_at: iso(now, REQUEST_TTL_S),
  });
  return { kind: "consent", requestId: id };
}

/** Godkänn: a single-use code for this user, back to the client. Null when the request is gone or expired. */
export async function approve(requestId: string, userId: string, store: McpStore, origin: string, now = new Date()): Promise<string | null> {
  if (!looksLike("request", requestId)) return null;
  const req = await store.takeRequest(requestId);
  if (!req || Date.parse(req.expires_at) <= now.getTime()) return null;
  const code = newToken("code");
  await store.createCode({
    code_hash: hashToken(code),
    client_id: req.client_id,
    user_id: userId,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    resource: req.resource,
    expires_at: iso(now, CODE_TTL_S),
  });
  return redirectWith(req.redirect_uri, { code, state: req.state, iss: origin });
}

/** Avbryt (or not allowed): access_denied back to the client. Null when the request is gone. */
export async function deny(requestId: string, store: McpStore, origin: string): Promise<string | null> {
  if (!looksLike("request", requestId)) return null;
  const req = await store.takeRequest(requestId);
  if (!req) return null;
  return redirectWith(req.redirect_uri, { error: "access_denied", state: req.state, iss: origin });
}

// ---------------------------------------------------------------------------------------------
// POST /api/oauth/token

async function issue(store: McpStore, grantId: string, now: Date): Promise<Reply> {
  const access = newToken("access");
  const refresh = newToken("refresh");
  await store.addTokens(grantId, [
    { hash: hashToken(access), kind: "access", expiresAt: iso(now, ACCESS_TTL_S) },
    { hash: hashToken(refresh), kind: "refresh", expiresAt: iso(now, REFRESH_TTL_S) },
  ]);
  return { status: 200, body: { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE } };
}

export async function token(form: URLSearchParams, store: McpStore, origin: string, now = new Date()): Promise<Reply> {
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  const client = looksLike("client", clientId) ? await store.getClient(clientId) : null;
  if (!client) return oauthError(401, "invalid_client", "unknown client_id");
  if (!resourceMatches(form.get("resource"), origin)) return oauthError(400, "invalid_target", "resource is not this server");

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    if (!looksLike("code", code) || !verifier) return oauthError(400, "invalid_request", "code and code_verifier are required");
    // Taken (deleted) before any check: a code is spent by its first use, right or wrong.
    const row = await store.takeCode(hashToken(code));
    if (!row || Date.parse(row.expires_at) <= now.getTime()) return oauthError(400, "invalid_grant", "code is invalid or expired");
    if (row.client_id !== client.id) return oauthError(400, "invalid_grant", "code was issued to another client");
    const redirect = form.get("redirect_uri");
    if (redirect !== null && redirect !== row.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri does not match");
    if (!verifyPkce(verifier, row.code_challenge)) return oauthError(400, "invalid_grant", "code_verifier does not match");
    if (row.resource !== resourceUri(origin)) return oauthError(400, "invalid_target", "resource is not this server");
    const grantId = await store.grantFor(row.user_id, client, row.resource);
    return issue(store, grantId, now);
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    if (!looksLike("refresh", refresh)) return oauthError(400, "invalid_grant", "refresh_token is invalid");
    const spent = await store.spendRefresh(hashToken(refresh));
    if (!spent) return oauthError(400, "invalid_grant", "refresh_token is invalid or expired");
    const grant = await store.getGrant(spent.grantId);
    if (spent.reused) {
      // A spent refresh token presented again: someone else may hold it. End the whole grant.
      if (grant) await store.revokeGrant(grant.id);
      console.warn(`mcp: refresh token reuse, grant ${spent.grantId} revoked`);
      return oauthError(400, "invalid_grant", "refresh_token was already used");
    }
    if (!grant || grant.revoked_at || grant.client_id !== client.id) return oauthError(400, "invalid_grant", "refresh_token is invalid");
    if (grant.resource !== resourceUri(origin)) return oauthError(400, "invalid_target", "resource is not this server");
    return issue(store, grant.id, now);
  }

  return oauthError(400, "unsupported_grant_type", "authorization_code or refresh_token");
}

// ---------------------------------------------------------------------------------------------
// POST /api/oauth/revoke (RFC 7009): always 200, whatever the token was.

export async function revoke(form: URLSearchParams, store: McpStore): Promise<Reply> {
  const value = form.get("token") ?? "";
  if (looksLike("access", value) || looksLike("refresh", value)) {
    const grantId = await store.grantOfToken(hashToken(value));
    if (grantId) await store.revokeGrant(grantId);
  }
  return { status: 200, body: {} };
}
