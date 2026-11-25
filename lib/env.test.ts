import { randomBytes } from "node:crypto";
import { testEnv } from "@/test/env";
import { describe, expect, it } from "vitest";
import * as envModule from "./env";
import { getEnv, parseEnv, pickerEnabled } from "./env";

const valid: Record<string, string> = { ...testEnv };

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

  it("defaults ELEVENLABS_COMMIT_STRATEGY to vad and accepts turn_prediction", () => {
    const { ELEVENLABS_COMMIT_STRATEGY: _, ...rest } = valid;
    expect(parseEnv(rest).ELEVENLABS_COMMIT_STRATEGY).toBe("vad");
    expect(parseEnv({ ...valid, ELEVENLABS_COMMIT_STRATEGY: "turn_prediction" }).ELEVENLABS_COMMIT_STRATEGY).toBe(
      "turn_prediction",
    );
    expect(() => parseEnv({ ...valid, ELEVENLABS_COMMIT_STRATEGY: "on" })).toThrow(/ELEVENLABS_COMMIT_STRATEGY/);
  });

  it("defaults ELEVENLABS_USD_PER_HOUR to 0.22 and rejects a negative rate", () => {
    expect(parseEnv(valid).ELEVENLABS_USD_PER_HOUR).toBe(0.22);
    expect(parseEnv({ ...valid, ELEVENLABS_USD_PER_HOUR: "0.48" }).ELEVENLABS_USD_PER_HOUR).toBe(0.48);
    expect(() => parseEnv({ ...valid, ELEVENLABS_USD_PER_HOUR: "-1" })).toThrow(/ELEVENLABS_USD_PER_HOUR/);
  });

  it("rejects non-finite global caps (Infinity would switch them off)", () => {
    expect(() => parseEnv({ ...valid, GLOBAL_DAILY_HOURS: "Infinity" })).toThrow(/GLOBAL_DAILY_HOURS/);
    expect(() => parseEnv({ ...valid, GLOBAL_DAILY_USD: "Infinity" })).toThrow(/GLOBAL_DAILY_USD/);
  });

  it("KILL_SWITCH is strictly 0 or 1", () => {
    for (const v of ["true", "on", "yes", "2"]) expect(() => parseEnv({ ...valid, KILL_SWITCH: v }), v).toThrow(/KILL_SWITCH/);
  });

  it("parses KILL_SWITCH=1 as on", () => {
    expect(parseEnv({ ...valid, KILL_SWITCH: "1" }).KILL_SWITCH).toBe(true);
  });

  it("treats empty optional keys as missing", () => {
    const env = parseEnv({ ...valid, RESEND_API_KEY: "" });
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("GOOGLE_PICKER_API_KEY and GOOGLE_PROJECT_NUMBER are optional; the Picker needs both", () => {
    const env = parseEnv(valid);
    expect(env.GOOGLE_PICKER_API_KEY).toBeUndefined();
    expect(env.GOOGLE_PROJECT_NUMBER).toBeUndefined();
    expect(pickerEnabled(env)).toBe(false);
    expect(pickerEnabled(parseEnv({ ...valid, GOOGLE_PICKER_API_KEY: "k", GOOGLE_PROJECT_NUMBER: "" }))).toBe(false);
    const on = parseEnv({ ...valid, GOOGLE_PICKER_API_KEY: "k", GOOGLE_PROJECT_NUMBER: "123456789012" });
    expect(on.GOOGLE_PICKER_API_KEY).toBe("k");
    expect(on.GOOGLE_PROJECT_NUMBER).toBe("123456789012");
    expect(pickerEnabled(on)).toBe(true);
  });

  it("requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", () => {
    expect(() => parseEnv({ ...valid, GOOGLE_CLIENT_ID: "" })).toThrow(/GOOGLE_CLIENT_ID/);
    const { GOOGLE_CLIENT_SECRET: _, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/GOOGLE_CLIENT_SECRET/);
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
