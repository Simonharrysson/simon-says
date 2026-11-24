/**
 * Shared setup for the Google early-check scripts: loads ~/simon-says-private/.env (override
 * with SIMON_SAYS_ENV), fetches the service-role key with SUPABASE_ACCESS_TOKEN when it is not
 * set, and resolves a user (id or email) to a ready OAuth2Client. Never prints secrets.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuth2Client } from "google-auth-library";

export const PROJECT_REF = "orvdeynkpfcujocrjgud";

function loadEnvFile(path: string): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export async function prepareEnv(): Promise<void> {
  loadEnvFile(process.env.SIMON_SAYS_ENV ?? join(homedir(), "simon-says-private", ".env"));
  process.env.SUPABASE_URL ??= `https://${PROJECT_REF}.supabase.co`;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!token) throw new Error("need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ACCESS_TOKEN");
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`fetching api keys: HTTP ${res.status}`);
    const keys = (await res.json()) as { name: string; api_key: string }[];
    const service = keys.find((k) => k.name === "service_role")?.api_key;
    const anon = keys.find((k) => k.name === "anon")?.api_key;
    if (!service) throw new Error("no service_role key in the api-keys response");
    process.env.SUPABASE_SERVICE_ROLE_KEY = service;
    process.env.SUPABASE_ANON_KEY ??= anon;
  }
  // Required by lib/env but unused by the check scripts.
  const unused: Record<string, string> = {
    SUPABASE_ANON_KEY: "unused-by-check-scripts",
    ELEVENLABS_API_KEY: "unused-by-check-scripts",
    ELEVENLABS_COMMIT_STRATEGY: "vad",
    ANTHROPIC_API_KEY: "unused-by-check-scripts",
    ALARM_EMAIL: "unused@example.com",
    CRON_SECRET: "unused-by-check-scripts",
    APP_URL: "http://localhost:3000",
  };
  for (const [k, v] of Object.entries(unused)) process.env[k] ??= v;
}

/** `userArg` is a Supabase user id or an email. Call after prepareEnv(). */
export async function authFor(userArg: string): Promise<{ userId: string; auth: OAuth2Client }> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { getGoogleAuth } = await import("@/lib/google/client");
  let userId = userArg;
  if (userArg.includes("@")) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === userArg.toLowerCase());
    if (!user) throw new Error(`no Supabase user with email ${userArg}`);
    userId = user.id;
  }
  return { userId, auth: await getGoogleAuth(userId) };
}

export const errInfo = (err: unknown) => {
  const e = err as { status?: number; code?: number; response?: { status?: number }; message?: string };
  return { status: e.status ?? e.response?.status ?? e.code, message: e.message };
};
