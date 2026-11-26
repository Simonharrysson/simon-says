import { describe, expect, it } from "vitest";
import { e2eGoogleRoot, e2eMailUrl, e2eMode, e2eRefusal } from "./guard";

const on = { E2E_TEST_MODE: "1", NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321" };

describe("e2eMode", () => {
  it("is on only for a local dev server with the flag", () => {
    expect(e2eMode(on)).toBe(true);
    expect(e2eMode({ ...on, SUPABASE_URL: "http://localhost:54321" })).toBe(true);
    expect(e2eMode({ ...on, NODE_ENV: "test" })).toBe(true);
  });

  it.each([
    ["flag missing", { ...on, E2E_TEST_MODE: undefined }],
    ["flag not exactly 1", { ...on, E2E_TEST_MODE: "true" }],
    ["production build", { ...on, NODE_ENV: "production" }],
    ["on Vercel", { ...on, VERCEL: "1" }],
    ["a Vercel preview", { ...on, VERCEL_ENV: "preview" }],
    ["the hosted Supabase", { ...on, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }],
    ["a look-alike host", { ...on, SUPABASE_URL: "http://127.0.0.1.evil.example" }],
    ["no Supabase URL", { ...on, SUPABASE_URL: undefined }],
  ])("is off: %s", (_why, source) => {
    expect(e2eMode(source)).toBe(false);
    expect(e2eRefusal(source)).not.toBeNull();
  });
});

describe("e2eGoogleRoot", () => {
  it("points Google at the fake only in the e2e mode", () => {
    expect(e2eGoogleRoot({ ...on, E2E_GOOGLE_ROOT: "http://127.0.0.1:4010/google" })).toBe("http://127.0.0.1:4010/google/");
    expect(e2eGoogleRoot({ ...on, NODE_ENV: "production", E2E_GOOGLE_ROOT: "http://127.0.0.1:4010/google/" })).toBeUndefined();
    expect(e2eGoogleRoot(on)).toBeUndefined();
  });

  it("refuses a non-loopback root", () => {
    expect(() => e2eGoogleRoot({ ...on, E2E_GOOGLE_ROOT: "https://example.com/" })).toThrow(/loopback/);
  });
});

describe("e2eMailUrl", () => {
  it("sends mail to the fake only in the e2e mode", () => {
    expect(e2eMailUrl({ ...on, E2E_MAIL_URL: "http://127.0.0.1:4010/resend/emails" })).toBe("http://127.0.0.1:4010/resend/emails");
    expect(e2eMailUrl({ ...on, NODE_ENV: "production", E2E_MAIL_URL: "http://127.0.0.1:4010/resend/emails" })).toBeUndefined();
    expect(() => e2eMailUrl({ ...on, E2E_MAIL_URL: "https://api.resend.com/emails" })).toThrow(/loopback/);
  });
});
