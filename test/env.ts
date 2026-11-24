import { randomBytes } from "node:crypto";

/** A complete, valid env for tests. Assign to process.env before the first getEnv(). */
export const testEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  TOKEN_ENC_KEY: randomBytes(32).toString("base64"),
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_COMMIT_STRATEGY: "vad",
  ANTHROPIC_API_KEY: "ant",
  ALARM_EMAIL: "alarm@example.com",
  CRON_SECRET: "cron",
  APP_URL: "https://example.com",
};

export function useTestEnv(): void {
  Object.assign(process.env, testEnv);
}
