import "server-only";
import { z } from "zod";

// Server-only environment, validated with zod.
//
// Optional until their task lands (the deploy must work without them):
//   RESEND_API_KEY  -> without it lib/mail.ts only logs (no email leaves); set it in Vercel to send

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
  MAIL_FROM: optional,
  ALARM_EMAIL: z.email(),
  // Comma list of emails allowed to run Testmöte; falls back to ALARM_EMAIL (see lib/testmeeting/admin.ts).
  ADMIN_EMAILS: optional,
  // Företag (0050): comma list of e-mails allowed to create a company space, until a DPA exists;
  // falls back to ADMIN_EMAILS, then ALARM_EMAIL (lib/foretag/gate.ts).
  FORETAG_CREATOR_EMAILS: optional,
  // The MCP server (/api/mcp): the project's JWT secret, to sign the short-lived JWT an MCP call
  // runs under as the user (RLS). As powerful as the service role key. Absent: MCP is off (503).
  SUPABASE_JWT_SECRET: optional,
  // Google Picker (A11): an API key restricted to the Picker API + our referrers, and the Cloud
  // project number (the Picker's appId, needed for drive.file grants). Both absent: the Picker is
  // off and the start screen offers only "Skapa nytt dokument".
  GOOGLE_PICKER_API_KEY: optional,
  GOOGLE_PROJECT_NUMBER: optional,
  CRON_SECRET: required,
  APP_URL: z.url(),
  // finite(): "Infinity" would switch the global caps off.
  GLOBAL_DAILY_HOURS: z.coerce.number().positive().finite().default(30),
  GLOBAL_DAILY_USD: z.coerce.number().positive().finite().default(25),
  // Booked on every closed ElevenLabs session (Ruling 14). Creator overage rate.
  ELEVENLABS_USD_PER_HOUR: z.coerce.number().nonnegative().finite().default(0.22),
  // Strictly "0" or "1": anything else ("true", "on", "") fails at boot rather than silently
  // meaning off.
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

/** The Google Picker is configured (both of its env vars are set). */
export function pickerEnabled(env: Pick<Env, "GOOGLE_PICKER_API_KEY" | "GOOGLE_PROJECT_NUMBER">): boolean {
  return Boolean(env.GOOGLE_PICKER_API_KEY && env.GOOGLE_PROJECT_NUMBER);
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
