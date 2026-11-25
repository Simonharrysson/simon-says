import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { recordClaudeUsage } from "@/lib/db/claude-usage";
import { dayUsd } from "@/lib/db/usage";
import { getEnv } from "@/lib/env";
import { FALLBACK_BETA, messageUsage, NOTES_MODEL, type NotesClient, type NotesUsage } from "./engine";

// One shared one-shot Claude call (pre-flight F17): the notes engine's settings (model,
// server-side fallbacks, effort medium, structured output via output_config.format, stop_reason
// checked before content), usage recorded per org, KILL_SWITCH and the daily dollar cap checked
// first. Reused by agenda role matching (A5), check-in detection (A8), format learning (B1) and
// stadgar items (C1). Never throws and never logs prompt or answer text: the caller falls back.

export const ONESHOT_TIMEOUT_MS = 45_000;

export type OneShotResult<T> =
  | { ok: true; value: T; usage: NotesUsage }
  | { ok: false; reason: "spend" | "request" | "stop_reason" | "malformed"; detail: string; usage: NotesUsage | null };

export interface OneShotInput<T> {
  /** Short name for logs ("agenda roles"). */
  label: string;
  system: string;
  user: string;
  /** Base64 PDFs sent as `document` blocks before the user text (stadgar, C1). */
  pdfs?: string[];
  /** JSON schema for output_config.format. */
  jsonSchema: Record<string, unknown>;
  /** Validates the parsed JSON. */
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Usage is recorded on this org (none: not recorded). */
  orgId: string | null;
  client?: NotesClient;
  timeoutMs?: number;
  /** Default true: skip the call under KILL_SWITCH or once the daily dollar cap is reached. */
  checkSpend?: boolean;
}

/** False under KILL_SWITCH or when today's Claude spend has reached GLOBAL_DAILY_USD. */
export async function claudeAllowed(): Promise<boolean> {
  const env = getEnv();
  if (env.KILL_SWITCH) return false;
  return (await dayUsd()) < env.GLOBAL_DAILY_USD;
}

export function buildOneShotRequest(
  input: Pick<OneShotInput<unknown>, "system" | "user" | "jsonSchema" | "maxTokens" | "pdfs">,
): BetaMessageStreamParams {
  const documents = (input.pdfs ?? []).map((data) => ({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data },
  }));
  return {
    model: NOTES_MODEL,
    max_tokens: input.maxTokens ?? 4000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: input.jsonSchema } },
    system: input.system,
    messages: [{ role: "user", content: [...documents, { type: "text", text: input.user }] }],
  } as BetaMessageStreamParams;
}

function parse<T>(message: BetaMessage, schema: z.ZodType<T>): T | null {
  const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  for (const candidate of texts.length > 1 ? [texts.join(""), texts[texts.length - 1]] : texts) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON: try the next candidate
    }
  }
  return null;
}

export async function oneShot<T>(input: OneShotInput<T>): Promise<OneShotResult<T>> {
  try {
    if ((input.checkSpend ?? true) && !(await claudeAllowed())) {
      return { ok: false, reason: "spend", detail: "kill switch or daily cap", usage: null };
    }
  } catch (e) {
    // Cannot read the spend: do not call.
    return { ok: false, reason: "spend", detail: `spend check failed: ${(e as Error).message}`.slice(0, 200), usage: null };
  }

  let message: BetaMessage;
  try {
    const client =
      input.client ??
      (new Anthropic({
        apiKey: getEnv().ANTHROPIC_API_KEY,
        timeout: input.timeoutMs ?? ONESHOT_TIMEOUT_MS,
        maxRetries: 0,
      }) as unknown as NotesClient);
    message = await client.beta.messages.stream(buildOneShotRequest(input)).finalMessage();
  } catch (err) {
    const e = err as Error | undefined;
    const detail = `${e?.constructor?.name ?? "Error"}: ${String(e?.message ?? err)}`.slice(0, 200);
    console.error(`${input.label}: request failed: ${detail}`);
    return { ok: false, reason: "request", detail, usage: null };
  }

  // Usage first: a refusal or a max_tokens stop costs tokens too.
  const usage = messageUsage(message.usage, message.model ?? NOTES_MODEL);
  if (input.orgId) {
    try {
      await recordClaudeUsage(input.orgId, usage);
    } catch (e) {
      console.error(`${input.label}: usage: ${(e as Error).message}`);
    }
  }

  if (message.stop_reason !== "end_turn") {
    console.error(`${input.label}: stop_reason ${message.stop_reason}`);
    return { ok: false, reason: "stop_reason", detail: String(message.stop_reason), usage };
  }
  const value = parse(message, input.schema);
  if (value === null) {
    console.error(`${input.label}: malformed output`);
    return { ok: false, reason: "malformed", detail: "malformed output", usage };
  }
  return { ok: true, value, usage };
}
