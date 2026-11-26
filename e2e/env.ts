import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// The e2e run's environment: the app (next dev) and the fakes get the same values. Supabase is
// the local stack (CI exports LOCAL_SUPABASE_*; locally `supabase status` is asked). Secrets are
// random per run, never committed (gitleaks scans the history). Everything external points at the
// fakes (e2e/fakes/server.ts).

export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3100);
export const FAKE_PORT = Number(process.env.E2E_FAKE_PORT ?? 4010);
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;

/** The shared admin's session (written by global-setup.ts). */
export const STORAGE_ADMIN = fileURLToPath(new URL("./.auth/admin.json", import.meta.url));

/** The shared signed-in admin (storage state): may run Testmöte (ADMIN_EMAILS). */
export const ADMIN_EMAIL = "admin@e2e.test";

function localSupabase(): { url: string; anon: string; service: string } {
  const { LOCAL_SUPABASE_API_URL: url, LOCAL_SUPABASE_ANON_KEY: anon, LOCAL_SUPABASE_SERVICE_ROLE_KEY: service } = process.env;
  if (url && anon && service) return { url, anon, service };
  // Pages that need no database (landing, login, integritet) can run without the stack.
  if (process.env.E2E_NO_DB === "1") return { url: "http://127.0.0.1:54321", anon: "none", service: "none" };
  let out: string;
  try {
    out = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("e2e: no local Supabase. Run `supabase start && supabase db reset` first (needs Docker), or set LOCAL_SUPABASE_*.");
  }
  const get = (k: string) => out.match(new RegExp(`^${k}="?([^"\\n]*)"?$`, "m"))?.[1] ?? "";
  const found = { url: get("API_URL"), anon: get("ANON_KEY"), service: get("SERVICE_ROLE_KEY") };
  if (!found.url || !found.anon || !found.service) throw new Error("e2e: `supabase status -o env` gave no API_URL/ANON_KEY/SERVICE_ROLE_KEY");
  // Cache for the workers (they inherit the runner's env).
  Object.assign(process.env, { LOCAL_SUPABASE_API_URL: found.url, LOCAL_SUPABASE_ANON_KEY: found.anon, LOCAL_SUPABASE_SERVICE_ROLE_KEY: found.service });
  return found;
}

/** Random per run, the same in the runner and its workers (set once, inherited). */
function runSecret(name: string, make: () => string): string {
  process.env[name] ??= make();
  return process.env[name]!;
}

export function e2eEnv(): Record<string, string> {
  const sb = localSupabase();
  return {
    E2E_TEST_MODE: "1",
    SUPABASE_URL: sb.url,
    SUPABASE_ANON_KEY: sb.anon,
    SUPABASE_SERVICE_ROLE_KEY: sb.service,
    GOOGLE_CLIENT_ID: "e2e-client",
    GOOGLE_CLIENT_SECRET: "e2e",
    GOOGLE_PICKER_API_KEY: "e2e",
    GOOGLE_PROJECT_NUMBER: "100000000001",
    E2E_GOOGLE_ROOT: `${FAKE_URL}/`,
    TOKEN_ENC_KEY: runSecret("E2E_TOKEN_ENC_KEY", () => randomBytes(32).toString("base64")),
    ELEVENLABS_API_KEY: "e2e",
    ELEVENLABS_WS_URL: `ws://127.0.0.1:${FAKE_PORT + 1}/v1/speech-to-text/realtime`,
    ANTHROPIC_API_KEY: "e2e",
    ANTHROPIC_BASE_URL: `${FAKE_URL}/anthropic`,
    RESEND_API_KEY: "",
    ALARM_EMAIL: "alarm@e2e.test",
    ADMIN_EMAILS: ADMIN_EMAIL,
    CRON_SECRET: runSecret("E2E_CRON_SECRET", () => randomBytes(16).toString("hex")),
    APP_URL,
    E2E_FAKE_PORT: String(FAKE_PORT),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
