import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

useTestEnv();

const g = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    getToken = g.getToken;
  },
}));

const { authorizeUrl, checkDriveAccountState, exchangeDriveAccountCode, returnPath, startDriveAccountFlow } = await import("./drive-account-oauth");
const { encrypt } = await import("@/lib/crypto");
const { DRIVE_FILE } = await import("./scopes");

const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("authorize URL", () => {
  it("our client, the fixed callback, drive.file + identity only, account chooser, offline, PKCE S256", () => {
    const url = new URL(authorizeUrl({ state: "st", verifier: "v".repeat(64), loginHint: null }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      client_id: "gid",
      redirect_uri: "https://example.com/api/google/drive-account/callback",
      response_type: "code",
      scope: `openid email ${DRIVE_FILE}`,
      access_type: "offline",
      prompt: "select_account consent",
      state: "st",
      code_challenge_method: "S256",
    });
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Never wider, never merged with earlier grants of that account.
    expect(p.scope).not.toMatch(/readonly|profile|calendar/);
    expect(p).not.toHaveProperty("include_granted_scopes");
    expect(p).not.toHaveProperty("login_hint");
  });

  it("login_hint only when given", () => {
    expect(new URL(authorizeUrl({ state: "s", verifier: "v", loginHint: "styrelsen@ekdala.test" })).searchParams.get("login_hint")).toBe("styrelsen@ekdala.test");
  });

  it("returns to the step it came from", () => {
    expect(returnPath(ORG, "kom-igang")).toBe(`/orgs/${ORG}/kom-igang?steg=3`);
    expect(returnPath(ORG, "installningar")).toBe(`/orgs/${ORG}?flik=installningar&del=moten`);
  });
});

describe("the sealed state (CSRF: bound to the session's user and the förening)", () => {
  const NOW = 1_800_000_000_000;
  const flow = () => startDriveAccountFlow({ userId: "u-admin", orgId: ORG, from: "installningar", now: NOW });
  const stateOf = (url: string) => new URL(url).searchParams.get("state");

  it("the same user, the matching state, in time: the förening and the PKCE verifier", () => {
    const { cookie, url } = flow();
    const check = checkDriveAccountState(cookie, stateOf(url), "u-admin", NOW + 60_000);
    expect(check).toMatchObject({ ok: true, orgId: ORG, from: "installningar" });
    expect(cookie).not.toContain(ORG); // encrypted, not readable
  });

  it("refuses: no cookie, another user, another state, too late, a forged cookie", () => {
    const { cookie, url } = flow();
    expect(checkDriveAccountState(undefined, stateOf(url), "u-admin", NOW)).toEqual({ ok: false, reason: "missing" });
    expect(checkDriveAccountState(cookie, stateOf(url), "u-other", NOW)).toEqual({ ok: false, reason: "user" });
    expect(checkDriveAccountState(cookie, stateOf(url), null, NOW)).toEqual({ ok: false, reason: "user" });
    expect(checkDriveAccountState(cookie, "someone-elses-state", "u-admin", NOW)).toEqual({ ok: false, reason: "state" });
    expect(checkDriveAccountState(cookie, null, "u-admin", NOW)).toEqual({ ok: false, reason: "state" });
    expect(checkDriveAccountState(cookie, stateOf(url), "u-admin", NOW + 11 * 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(checkDriveAccountState("v1:AAAA" + cookie.slice(7), stateOf(url), "u-admin", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(checkDriveAccountState(encrypt(JSON.stringify({ n: 1 })), stateOf(url), "u-admin", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("exchangeDriveAccountCode", () => {
  const info = (over: Record<string, unknown> = {}) =>
    vi.fn(async () => new Response(JSON.stringify({ aud: "gid", sub: "sub-ekdala", email: "Styrelsen@ekdala.test", email_verified: "true", scope: `openid email ${DRIVE_FILE}`, ...over })));
  beforeEach(() => {
    g.getToken.mockReset().mockResolvedValue({ tokens: { access_token: "at", refresh_token: "rt" } });
  });

  it("the account's id, verified address (lower case), refresh token and real scope", async () => {
    const fetchImpl = info();
    const r = await exchangeDriveAccountCode("code", "verifier", fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, account: { refreshToken: "rt", scope: `openid email ${DRIVE_FILE}`, sub: "sub-ekdala", email: "styrelsen@ekdala.test" } });
    expect(g.getToken).toHaveBeenCalledWith({ code: "code", codeVerifier: "verifier" });
  });

  it("a token for another client, or an unverified address: refused", async () => {
    expect(await exchangeDriveAccountCode("c", "v", info({ aud: "someone-else" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "identity" });
    expect(await exchangeDriveAccountCode("c", "v", info({ email_verified: "false" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "identity" });
    expect(await exchangeDriveAccountCode("c", "v", info({ sub: "" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "identity" });
  });

  it("Drive unticked: no_drive; no refresh token: no_refresh (nothing stored either way)", async () => {
    expect(await exchangeDriveAccountCode("c", "v", info({ scope: "openid email" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "no_drive" });
    g.getToken.mockResolvedValue({ tokens: { access_token: "at" } });
    expect(await exchangeDriveAccountCode("c", "v", info() as unknown as typeof fetch)).toEqual({ ok: false, reason: "no_refresh" });
  });
});
