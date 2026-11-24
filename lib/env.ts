import "server-only";
import { z } from "zod";

// Server-only environment, validated with zod.
//
// Optional until their task lands (the deploy must work without them):
//   RESEND_API_KEY  -> required from Task 12 (alarm/summary email)
// When those tasks land, drop `.optional()` on the key and set it in Vercel first.

const required = z.string().min(1);
// Treat "" as missing, so an empty Vercel value doesn't count as configured.
const optional = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const tokenEncKey = required.transform((value, ctx) => {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) {
    ctx.addIssue({ code: "custom", message: `must be 32 bytes (base64), got ${bytes.length}` });
    return z.NEVER;
  }
  return bytes;
});

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: required,
  SUPABASE_SERVICE_ROLE_KEY: required,
  GOOGLE_CLIENT_ID: required,
  GOOGLE_CLIENT_SECRET: required,
  TOKEN_ENC_KEY: tokenEncKey,
  ELEVENLABS_API_KEY: required,
  // Provisional default until the Task 0 spike (2026-11-28) picks the strategy.
  ELEVENLABS_COMMIT_STRATEGY: z.enum(["manual", "vad", "turn_prediction"]).default("vad"),
  ANTHROPIC_API_KEY: required,
  RESEND_API_KEY: optional,
  ALARM_EMAIL: z.email(),
  CRON_SECRET: required,
  APP_URL: z.url(),
  GLOBAL_DAILY_HOURS: z.coerce.number().positive().default(30),
  GLOBAL_DAILY_USD: z.coerce.number().positive().default(25),
  // Booked on every closed ElevenLabs session (Ruling 14). Creator overage rate.
  ELEVENLABS_USD_PER_HOUR: z.coerce.number().nonnegative().default(0.22),
  KILL_SWITCH: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});

export type Env = z.infer<typeof schema>;

/** Validate an env source. Throws one error listing every bad key by name. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Lazily validated process env (so `next build` and CI don't need secrets).
 * Always call `getEnv()`; there is deliberately no `env` object export.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
