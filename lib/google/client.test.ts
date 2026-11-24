import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

const row = vi.hoisted(() => ({ current: null as null | { refresh_token_enc: string } }));
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
