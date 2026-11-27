import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowedOrigin,
  bearerChallenge,
  bearerToken,
  hashToken,
  looksLike,
  newToken,
  parseRegistration,
  redirectMatches,
  redirectAudience,
  registrableRedirect,
  resourceMatches,
  verifyPkce,
} from "./oauth";

const O = "https://simonsays.harrysson.co";

describe("tokens", () => {
  it("are opaque, prefixed, and only their sha256 is stored", () => {
    const t = newToken("access");
    expect(looksLike("access", t)).toBe(true);
    expect(looksLike("refresh", t)).toBe(false);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t.slice(4, 20));
    expect(newToken("access")).not.toBe(t);
  });
  it("Bearer parsing", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Basic xyz")).toBeNull();
  });
});

describe("PKCE S256", () => {
  const verifier = "a".repeat(20) + "-._~" + "B".repeat(30);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  it("accepts the right verifier only", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(verifier + "x", challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    // "plain" (verifier == challenge) never passes.
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("registers https anywhere, http only on loopback, never fragments or credentials", () => {
    expect(registrableRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(registrableRedirect("http://localhost:33418/callback")).toBe(true);
    expect(registrableRedirect("http://127.0.0.1/cb")).toBe(true);
    expect(registrableRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(registrableRedirect("http://evil.example/cb")).toBe(false);
    // Consent phishing: no other https host or path, look-alikes included.
    expect(registrableRedirect("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(registrableRedirect("https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
    expect(registrableRedirect("https://claude.ai/other")).toBe(false);
    expect(registrableRedirect("https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(registrableRedirect("https://a.example/cb#x")).toBe(false);
    expect(registrableRedirect("https://u:p@a.example/cb")).toBe(false);
    expect(registrableRedirect("javascript:alert(1)")).toBe(false);
    expect(registrableRedirect("custom-app://cb")).toBe(false);
  });
  it("names the audience from the redirect, never from the client's name", () => {
    expect(redirectAudience("https://claude.ai/api/mcp/auth_callback")).toEqual({ kind: "claude", host: "claude.ai" });
    expect(redirectAudience("http://localhost:3118/callback")).toEqual({ kind: "local", host: "localhost:3118" });
    expect(redirectAudience("https://evil.example/cb")).toEqual({ kind: "unknown", host: "evil.example" });
  });
  it("matches exactly, except any port on loopback", () => {
    expect(redirectMatches("https://claude.ai/cb", "https://claude.ai/cb")).toBe(true);
    expect(redirectMatches("https://claude.ai/cb/", "https://claude.ai/cb")).toBe(false);
    expect(redirectMatches("https://claude.ai:444/cb", "https://claude.ai/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1:5555/callback", "http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectMatches("http://127.0.0.1:5555/other", "http://127.0.0.1:33418/callback")).toBe(false);
    expect(redirectMatches("http://localhost:1/callback", "http://127.0.0.1:2/callback")).toBe(false);
  });
});

describe("resource (audience)", () => {
  it("is absent or this server's MCP endpoint", () => {
    expect(resourceMatches(undefined, O)).toBe(true);
    expect(resourceMatches(`${O}/api/mcp`, O)).toBe(true);
    expect(resourceMatches(`${O}/api/mcp/`, O)).toBe(true);
    expect(resourceMatches("HTTPS://SIMONSAYS.HARRYSSON.CO/api/mcp", O)).toBe(true);
    expect(resourceMatches(`${O}/api/other`, O)).toBe(false);
    expect(resourceMatches("https://evil.example/api/mcp", O)).toBe(false);
    expect(resourceMatches(`${O}/api/mcp#x`, O)).toBe(false);
  });
});

describe("registration", () => {
  it("public clients with valid redirect URIs only", () => {
    expect(parseRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" })).toMatchObject({ ok: true, value: { client_name: "Claude" } });
    expect(parseRegistration({ redirect_uris: [] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseRegistration({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" })).toMatchObject({ ok: false });
    expect(parseRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["client_credentials"] })).toMatchObject({ ok: false });
    expect(parseRegistration(null)).toMatchObject({ ok: false });
  });
  it("cleans the shown name", () => {
    const r = parseRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "  A\n\tB " + "x".repeat(200) });
    expect(r.ok && r.value.client_name.startsWith("A B")).toBe(true);
    expect(r.ok && r.value.client_name.length).toBe(100);
    expect(parseRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).toMatchObject({ value: { client_name: "AI-assistent" } });
  });
});

describe("origin and challenge", () => {
  it("allows no Origin, ours and Claude's", () => {
    expect(allowedOrigin(null, O)).toBe(true);
    expect(allowedOrigin(O, O)).toBe(true);
    expect(allowedOrigin("https://claude.ai", O)).toBe(true);
    expect(allowedOrigin("http://localhost:8080", O)).toBe(false);
    expect(allowedOrigin("https://evil.example", O)).toBe(false);
  });
  it("points the 401 at the resource metadata", () => {
    expect(bearerChallenge(O, "invalid_token")).toBe(
      `Bearer error="invalid_token", resource_metadata="${O}/.well-known/oauth-protected-resource/api/mcp", scope="meetings"`,
    );
  });
});
