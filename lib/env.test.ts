import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as envModule from "./env";
import { getEnv, parseEnv } from "./env";

const valid = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  TOKEN_ENC_KEY: randomBytes(32).toString("base64"),
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_COMMIT_STRATEGY: "vad",
  ANTHROPIC_API_KEY: "ant",
  ALARM_EMAIL: "alarm@example.com",
  CRON_SECRET: "cron",
  APP_URL: "https://example.com",
};

describe("parseEnv", () => {
  it("accepts a valid env and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.GLOBAL_DAILY_HOURS).toBe(30);
    expect(env.GLOBAL_DAILY_USD).toBe(25);
    expect(env.KILL_SWITCH).toBe(false);
    expect(env.TOKEN_ENC_KEY.length).toBe(32);
  });

  it("throws naming the key when TOKEN_ENC_KEY is missing", () => {
    const { TOKEN_ENC_KEY: _, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/TOKEN_ENC_KEY/);
  });

  it("throws 'must be 32 bytes' for a 16-byte key", () => {
    expect(() =>
      parseEnv({ ...valid, TOKEN_ENC_KEY: randomBytes(16).toString("base64") }),
    ).toThrow(/must be 32 bytes/);
  });

  it("defaults GLOBAL_DAILY_HOURS to 30", () => {
    expect(parseEnv(valid).GLOBAL_DAILY_HOURS).toBe(30);
  });

  it("parses KILL_SWITCH=1 as on", () => {
    expect(parseEnv({ ...valid, KILL_SWITCH: "1" }).KILL_SWITCH).toBe(true);
  });

  it("treats empty optional keys as missing", () => {
    const env = parseEnv({ ...valid, GOOGLE_CLIENT_ID: "", RESEND_API_KEY: "" });
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
  });
});

describe("getEnv", () => {
  it("validates process.env and returns a plain object (spread/keys/in work)", () => {
    Object.assign(process.env, valid);
    const env = getEnv();
    expect(Object.keys(env)).toContain("CRON_SECRET");
    expect("APP_URL" in env).toBe(true);
    expect({ ...env }.GLOBAL_DAILY_HOURS).toBe(30);
    expect(getEnv()).toBe(env); // cached
  });

  it("exports no Proxy-based `env` object", () => {
    expect("env" in envModule).toBe(false);
  });
});
