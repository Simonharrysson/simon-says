import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approve, authorize, deny, register, revoke, token } from "./endpoints";
import { hashToken } from "./oauth";
import { memoryStore } from "./store";

const O = "https://simonsays.test";
const CB = "https://claude.ai/api/mcp/auth_callback";
const USER = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const m = memoryStore();
  const reg = await register({ redirect_uris: [CB], client_name: "Claude" }, m.store);
  const clientId = reg.body.client_id as string;
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ client_id: clientId, redirect_uri: CB, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${O}/api/mcp`, ...extra });
  const codeFor = async () => {
    const out = await authorize(params(), m.store, O);
    if (out.kind !== "consent") throw new Error(out.kind);
    const url = new URL((await approve(out.requestId, USER, m.store, O))!);
    return url.searchParams.get("code")!;
  };
  const exchange = (code: string, extra: Record<string, string> = {}) =>
    token(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: CB, resource: `${O}/api/mcp`, ...extra }), m.store, O);
  return { m, clientId, params, codeFor, exchange, verifier };
}

describe("authorize", () => {
  it("never redirects to an unknown client or an unregistered redirect URI", async () => {
    const { m, params } = await setup();
    expect(await authorize(params({ client_id: "ssk_" + "x".repeat(43) }), m.store, O)).toEqual({ kind: "error_page", reason: "unknown_client" });
    expect(await authorize(params({ redirect_uri: "https://evil.example/cb" }), m.store, O)).toEqual({ kind: "error_page", reason: "bad_redirect" });
  });
  it("sends protocol errors back to the client with state and iss", async () => {
    const { m, params } = await setup();
    for (const [extra, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ] as const) {
      const out = await authorize(params(extra), m.store, O);
      expect(out.kind).toBe("redirect");
      const u = new URL((out as { url: string }).url);
      expect(u.origin + u.pathname).toBe(CB);
      expect(u.searchParams.get("error")).toBe(error);
      expect(u.searchParams.get("state")).toBe("s1");
      expect(u.searchParams.get("iss")).toBe(O);
    }
  });
  it("stores a valid request and denies with access_denied", async () => {
    const { m, params } = await setup();
    const out = await authorize(params(), m.store, O);
    expect(out.kind).toBe("consent");
    const url = new URL((await deny((out as { requestId: string }).requestId, m.store, O))!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(m.requests.size).toBe(0);
  });
});

describe("token", () => {
  it("exchanges a code once, with the right verifier", async () => {
    const { exchange, codeFor, m } = await setup();
    const code = await codeFor();
    // Only the hash is stored.
    expect([...m.codes.keys()]).toEqual([hashToken(code)]);
    const r = await exchange(code);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "meetings" });
    expect((await exchange(code)).body).toMatchObject({ error: "invalid_grant" });
    expect([...m.tokens.keys()]).not.toContain(r.body.access_token);
  });
  it("refuses a wrong verifier, and the code is spent anyway", async () => {
    const { exchange, codeFor } = await setup();
    const code = await codeFor();
    expect((await exchange(code, { code_verifier: randomBytes(40).toString("base64url") })).body).toMatchObject({ error: "invalid_grant" });
    expect((await exchange(code)).body).toMatchObject({ error: "invalid_grant" });
  });
  it("refuses another resource, redirect URI or client", async () => {
    const { exchange, codeFor, m } = await setup();
    expect((await exchange(await codeFor(), { resource: "https://evil.example/api/mcp" })).body).toMatchObject({ error: "invalid_target" });
    expect((await exchange(await codeFor(), { redirect_uri: "https://claude.ai/other" })).body).toMatchObject({ error: "invalid_grant" });
    const other = (await register({ redirect_uris: [CB] }, m.store)).body.client_id as string;
    expect((await exchange(await codeFor(), { client_id: other })).body).toMatchObject({ error: "invalid_grant" });
  });
  it("rotates refresh tokens; reusing a spent one revokes the grant", async () => {
    const { exchange, codeFor, m, clientId } = await setup();
    const first = (await exchange(await codeFor())).body;
    const refresh = (rt: string) => token(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: rt }), m.store, O);
    const second = await refresh(first.refresh_token as string);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    const reuse = await refresh(first.refresh_token as string);
    expect(reuse.body).toMatchObject({ error: "invalid_grant" });
    expect([...m.grants.values()][0].revoked_at).not.toBeNull();
    expect((await refresh(second.body.refresh_token as string)).status).toBe(400);
    expect(await m.store.grantForAccess(hashToken(second.body.access_token as string), new Date())).toBeNull();
  });
  it("revocation ends the grant", async () => {
    const { exchange, codeFor, m } = await setup();
    const t = (await exchange(await codeFor())).body;
    expect((await revoke(new URLSearchParams({ token: t.refresh_token as string }), m.store)).status).toBe(200);
    expect(await m.store.grantForAccess(hashToken(t.access_token as string), new Date())).toBeNull();
  });
  it("one grant per user and client on reconnect", async () => {
    const { exchange, codeFor, m } = await setup();
    await exchange(await codeFor());
    await exchange(await codeFor());
    expect(m.grants.size).toBe(1);
  });
});

describe("redirect allow-list", () => {
  it("refuses registering any https host but Claude's callback", async () => {
    const m = memoryStore();
    expect((await register({ redirect_uris: ["https://evil.example/api/mcp/auth_callback"] }, m.store)).body).toMatchObject({ error: "invalid_redirect_uri" });
    expect((await register({ redirect_uris: ["http://127.0.0.1:5000/callback"] }, m.store)).status).toBe(201);
  });
  it("never redirects for a client stored with a non-allow-listed URI (registered before the rule)", async () => {
    const m = memoryStore();
    await m.store.createClient({ id: "ssk_" + "a".repeat(43), client_name: "Old", redirect_uris: ["https://old.example/cb"] });
    const p = new URLSearchParams({ client_id: "ssk_" + "a".repeat(43), redirect_uri: "https://old.example/cb", response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    expect(await authorize(p, m.store, O)).toEqual({ kind: "error_page", reason: "bad_redirect" });
  });
});
