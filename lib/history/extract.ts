import "server-only";
import type { NotesClient, NotesUsage } from "@/lib/notes/engine";
import { oneShot } from "@/lib/notes/oneshot";
import {
  buildExtractUserText,
  cleanExtraction,
  EXTRACT_JSON_SCHEMA,
  EXTRACT_SYSTEM_PROMPT,
  ExtractAnswerSchema,
  type CleanProtocol,
} from "./extract-prompt";

// One old protocol → structured items (one oneShot call: model, KILL_SWITCH, daily cap, usage on
// the org). Logs never hold protocol text; the caller stores only the cleaned items.

export type ExtractResult =
  | { ok: true; protocol: CleanProtocol; usage: NotesUsage }
  | { ok: false; error: "spend" | "refusal" | "malformed" | "error"; usage: NotesUsage | null };

export async function extractProtocol(
  input: { orgId: string | null; title: string; text: string; people: string[] },
  opts: { client?: NotesClient; checkSpend?: boolean } = {},
): Promise<ExtractResult> {
  try {
    const res = await oneShot({
      label: "history extract",
      system: EXTRACT_SYSTEM_PROMPT,
      user: buildExtractUserText(input),
      jsonSchema: EXTRACT_JSON_SCHEMA,
      schema: ExtractAnswerSchema,
      // A long protocol can hold 60+ lines; thinking counts toward the cap.
      maxTokens: 16_000,
      timeoutMs: 110_000,
      orgId: input.orgId,
      client: opts.client,
      checkSpend: opts.checkSpend,
    });
    if (!res.ok) {
      if (res.reason === "spend") return { ok: false, error: "spend", usage: null };
      if (res.reason === "malformed") return { ok: false, error: "malformed", usage: res.usage };
      if (res.reason === "stop_reason") return { ok: false, error: res.detail === "refusal" ? "refusal" : "error", usage: res.usage };
      return { ok: false, error: "error", usage: res.usage };
    }
    return { ok: true, protocol: cleanExtraction(res.value, input.people), usage: res.usage };
  } catch (e) {
    console.error(`history extract: ${(e as Error).message}`.slice(0, 200));
    return { ok: false, error: "error", usage: null };
  }
}
