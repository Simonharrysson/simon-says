import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

const row = vi.hoisted(() => ({ current: null as null | { refresh_token_enc: string; scope?: string } }));
const upserts = vi.hoisted(() => [] as unknown[]);
const calls = vi.hoisted(() => ({ tables: [] as string[], gt: [] as [string, string][], deletes: [] as string[] }));
const getAccessToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      calls.tables.push(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row.current, error: null }),
            gt: (col: string, v: string) => {
              calls.gt.push([col, v]);
              return { maybeSingle: async () => ({ data: row.current, error: null }) };
            },
          }),
        }),
        upsert: async (value: unknown) => {
          upserts.push(value);
          return { error: null };
        },
        delete: () => ({
          eq: async () => {
            calls.deletes.push(table);
            return { error: null };
          },
        }),
      };
    },
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
  calls.tables.length = 0;
  calls.gt.length = 0;
  calls.deletes.length = 0;
  getAccessToken.mockReset();
});

const { getGoogleAuth, GoogleAuthLostError, storeGoogleToken, hasImportAccess, getImportGoogleAuth, DriveAccessMissingError, storeImportToken } = await import("./client");
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

describe("the import's separate drive.readonly grant", () => {
  const READONLY = "openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";

  it("a sign-in token whose reported scope includes drive.readonly still works as before", async () => {
    row.current = { refresh_token_enc: encrypt("1//both"), scope: READONLY };
    getAccessToken.mockResolvedValue({ token: "ya29" });
    const client = (await getGoogleAuth("u1")) as unknown as { credentials: unknown };
    expect(client.credentials).toEqual({ refresh_token: "1//both" });
  });

  it("the sign-in token (drive.file) works as before", async () => {
    row.current = { refresh_token_enc: encrypt("1//ok"), scope: "openid https://www.googleapis.com/auth/drive.file" };
    getAccessToken.mockResolvedValue({ token: "ya29" });
    const client = (await getGoogleAuth("u1")) as unknown as { credentials: unknown };
    expect(client.credentials).toEqual({ refresh_token: "1//ok" });
  });
});

describe("getImportGoogleAuth / hasImportAccess (google_import_tokens)", () => {
  const READONLY = "openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";

  it("stores the import token encrypted in its own table", async () => {
    await storeImportToken("u1", "1//import", READONLY);
    expect(calls.tables).toEqual(["google_import_tokens"]);
    const v = upserts[0] as { refresh_token_enc: string; scope: string };
    expect(v.refresh_token_enc).not.toContain("1//import");
    expect(v.scope).toBe(READONLY);
  });

  it("reads only the import table, only rows younger than 24 h, only with drive.readonly", async () => {
    row.current = { refresh_token_enc: encrypt("1//import"), scope: READONLY };
    expect(await hasImportAccess("u1")).toBe(true);
    expect(calls.tables).toEqual(["google_import_tokens"]);
    const [col, cutoff] = calls.gt[0];
    expect(col).toBe("created_at");
    expect(Math.abs(Date.parse(cutoff) - (Date.now() - 24 * 3600_000))).toBeLessThan(5000);
    row.current = { refresh_token_enc: encrypt("1//import"), scope: "openid https://www.googleapis.com/auth/drive.file" };
    expect(await hasImportAccess("u1")).toBe(false);
  });

  it("none or expired: DriveAccessMissingError; revoked: deleted, DriveAccessMissingError", async () => {
    await expect(getImportGoogleAuth("u1")).rejects.toBeInstanceOf(DriveAccessMissingError);
    row.current = { refresh_token_enc: encrypt("1//import"), scope: READONLY };
    getAccessToken.mockRejectedValue({ response: { data: { error: "invalid_grant" } } });
    await expect(getImportGoogleAuth("u1")).rejects.toBeInstanceOf(DriveAccessMissingError);
    expect(calls.deletes).toEqual(["google_import_tokens"]);
  });

  it("live: a client with the import token", async () => {
    row.current = { refresh_token_enc: encrypt("1//import"), scope: READONLY };
    getAccessToken.mockResolvedValue({ token: "ya29" });
    const client = (await getImportGoogleAuth("u1")) as unknown as { credentials: unknown };
    expect(client.credentials).toEqual({ refresh_token: "1//import" });
  });
});

