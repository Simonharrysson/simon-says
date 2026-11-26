import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

const row = vi.hoisted(() => ({ current: null as null | { refresh_token_enc: string; scope?: string } }));
const upserts = vi.hoisted(() => [] as unknown[]);
const getAccessToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row.current, error: null }) }) }),
      upsert: async (value: unknown) => {
        upserts.push(value);
        return { error: null };
      },
    }),
  }),
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    credentials: unknown;
    setCredentials(c: unknown) {
      this.credentials = c;
    }
    getAccessToken = getAccessToken;
  },
}));

beforeAll(useTestEnv);
beforeEach(() => {
  row.current = null;
  upserts.length = 0;
  getAccessToken.mockReset();
});

const { getGoogleAuth, GoogleAuthLostError, storeGoogleToken } = await import("./client");
const { encrypt } = await import("@/lib/crypto");

describe("storeGoogleToken", () => {
  it("stores the token encrypted, never in plain text", async () => {
    await storeGoogleToken("u1", "1//refresh", "openid");
    const stored = upserts[0] as { user_id: string; refresh_token_enc: string; scope: string };
    expect(stored.user_id).toBe("u1");
    expect(stored.scope).toBe("openid");
    expect(stored.refresh_token_enc).not.toContain("1//refresh");
  });
});

describe("getGoogleAuth", () => {
  it("throws GoogleAuthLostError when no token is stored", async () => {
    await expect(getGoogleAuth("u1")).rejects.toBeInstanceOf(GoogleAuthLostError);
  });

  it("throws GoogleAuthLostError on invalid_grant", async () => {
    row.current = { refresh_token_enc: encrypt("1//dead") };
    getAccessToken.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }),
    );
    await expect(getGoogleAuth("u1")).rejects.toBeInstanceOf(GoogleAuthLostError);
  });

  it("rethrows other errors as they are", async () => {
    row.current = { refresh_token_enc: encrypt("1//ok") };
    getAccessToken.mockRejectedValue(new Error("ECONNRESET"));
    await expect(getGoogleAuth("u1")).rejects.toThrow("ECONNRESET");
  });

  it("returns a client holding the decrypted refresh token", async () => {
    row.current = { refresh_token_enc: encrypt("1//ok") };
    getAccessToken.mockResolvedValue({ token: "ya29" });
    const client = (await getGoogleAuth("u1")) as unknown as { credentials: unknown };
    expect(client.credentials).toEqual({ refresh_token: "1//ok" });
  });
});

describe("getGoogleAuth with a drive.readonly grant (the protocol import's consent)", () => {
  const READONLY = "openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";
  const calls: URLSearchParams[] = [];
  let reply: () => Response;
  beforeEach(() => {
    calls.length = 0;
    reply = () => Response.json({ access_token: "ya29.narrow", expires_in: 3599 });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(new URLSearchParams(String(init.body)));
      return reply();
    });
  });

  it("everywhere but the import: an access token narrowed to the sign-in scopes, no refresh token on the client", async () => {
    row.current = { refresh_token_enc: encrypt("1//both"), scope: READONLY };
    const client = (await getGoogleAuth("u1")) as unknown as { credentials: { access_token?: string; refresh_token?: string }; refreshHandler?: unknown };
    expect(calls[0].get("scope")).toBe("openid email profile https://www.googleapis.com/auth/drive.file");
    expect(calls[0].get("refresh_token")).toBe("1//both");
    expect(client.credentials.access_token).toBe("ya29.narrow");
    expect(client.credentials.refresh_token).toBeUndefined();
    expect(typeof client.refreshHandler).toBe("function");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("the import asks for the full grant", async () => {
    row.current = { refresh_token_enc: encrypt("1//both"), scope: READONLY };
    getAccessToken.mockResolvedValue({ token: "ya29.full" });
    const client = (await getGoogleAuth("u1", { driveReadonly: true })) as unknown as { credentials: unknown };
    expect(calls).toHaveLength(0);
    expect(client.credentials).toEqual({ refresh_token: "1//both" });
  });

  it("a revoked grant is GoogleAuthLostError; a refused narrowing falls back to the full token", async () => {
    row.current = { refresh_token_enc: encrypt("1//both"), scope: READONLY };
    reply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(getGoogleAuth("u1")).rejects.toBeInstanceOf(GoogleAuthLostError);
    reply = () => Response.json({ error: "invalid_scope" }, { status: 400 });
    getAccessToken.mockResolvedValue({ token: "ya29.full" });
    const client = (await getGoogleAuth("u1")) as unknown as { credentials: unknown };
    expect(client.credentials).toEqual({ refresh_token: "1//both" });
  });

  it("a drive.file-only grant is unchanged (no narrowing call)", async () => {
    row.current = { refresh_token_enc: encrypt("1//ok"), scope: "openid https://www.googleapis.com/auth/drive.file" };
    getAccessToken.mockResolvedValue({ token: "ya29" });
    await getGoogleAuth("u1");
    expect(calls).toHaveLength(0);
  });
});

