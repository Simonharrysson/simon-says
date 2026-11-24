import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyCron } from "./cron";

beforeAll(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    TOKEN_ENC_KEY: randomBytes(32).toString("base64"),
    ELEVENLABS_API_KEY: "el",
    ELEVENLABS_COMMIT_STRATEGY: "vad",
    ANTHROPIC_API_KEY: "ant",
    ALARM_EMAIL: "alarm@example.com",
    CRON_SECRET: "s3cret",
    APP_URL: "https://example.com",
  });
});

const req = (authorization?: string) =>
  new Request("https://example.com/api/health", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("verifyCron", () => {
  it("accepts the matching bearer", () => {
    expect(verifyCron(req("Bearer s3cret"))).toBe(true);
  });
  it("rejects a mismatched bearer", () => {
    expect(verifyCron(req("Bearer wrong"))).toBe(false);
    expect(verifyCron(req("Bearer s3cret2"))).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifyCron(req())).toBe(false);
  });
});
