import type { BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import { messageUsage, NOTES_MODEL, type NotesUsage } from "@/lib/notes/engine";
import { BATCH_DISCOUNT } from "./cost";
import {
  buildExtractUserText,
  cleanExtraction,
  EXTRACT_JSON_SCHEMA,
  EXTRACT_SYSTEM_PROMPT,
  ExtractAnswerSchema,
  type CleanProtocol,
} from "./extract-prompt";

// The large-import path (0036, mode 'batch'): every meeting's extraction goes in ONE Anthropic
// Message Batch (half price; results come when the whole batch has ended, usually within an
// hour, at most 24 h). Same prompt, schema, model, effort and token cap as the direct path
// (extract.ts via oneShot), with two differences the Batches API forces:
//   - no `stream` and no server-side `fallbacks` (a batch request cannot set them): a refusal
//     comes back as a SUCCEEDED result with stop_reason "refusal", so stop_reason is checked
//     before the content, as in oneShot; the admin can read that one meeting again directly
//     ("Försök igen"), which does use the fallbacks;
//   - usage is billed at 50 %: messageUsage prices at the standard rate, so it is halved here.
// Pure apart from the client, which is passed in (tests use a fake).

/** The slice of the SDK client the batch path uses (`client.messages.batches`). */
export interface BatchClient {
  messages: {
    batches: {
      create(body: BatchCreateParams): PromiseLike<MessageBatch>;
      retrieve(id: string): PromiseLike<MessageBatch>;
      cancel(id: string): PromiseLike<MessageBatch>;
      results(id: string): PromiseLike<AsyncIterable<MessageBatchIndividualResponse>>;
      /** Removes an ENDED batch and its results at Anthropic (after they are saved). */
      delete(id: string): PromiseLike<unknown>;
    };
  };
}

/** custom_id per item row: `i<id>` (Drive ids can be 200 characters; custom_id allows 64). */
export const customId = (itemId: number) => `i${itemId}`;
export const itemIdOf = (customId: string): number | null => {
  const m = /^i(\d{1,15})$/.exec(customId);
  return m ? Number(m[1]) : null;
};

export type BatchRequest = BatchCreateParams.Request;

/** One meeting's extraction request (the same request oneShot builds, minus stream/fallbacks). */
export function buildBatchRequest(itemId: number, part: { title: string; text: string }): BatchRequest {
  return {
    custom_id: customId(itemId),
    params: {
      model: NOTES_MODEL,
      // A long protocol can hold 60+ lines; thinking counts toward the cap (as extract.ts).
      max_tokens: 16_000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACT_JSON_SCHEMA as unknown as Record<string, unknown> } },
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: buildExtractUserText(part) }] }],
    },
  };
}

/** Tokens and cost of a batch result: the standard price halved. */
export function batchUsage(usage: unknown, model: string): NotesUsage {
  const u = messageUsage(usage as BetaUsage, model);
  return { ...u, usd: u.usd * BATCH_DISCOUNT };
}

export type BatchOutcome =
  | { ok: true; protocol: CleanProtocol; usage: NotesUsage }
  /** `skipped`: never run (the batch was cancelled first); the rest ran or expired. */
  | { ok: false; reason: "refusal" | "malformed" | "error" | "expired" | "canceled"; usage: NotesUsage | null };

/** One batch result → the cleaned protocol (names scrubbed with `people` + every name Claude saw). */
export function readBatchResult(result: MessageBatchIndividualResponse["result"], people: string[], now = new Date()): BatchOutcome {
  if (result.type === "canceled") return { ok: false, reason: "canceled", usage: null };
  if (result.type === "expired") return { ok: false, reason: "expired", usage: null };
  if (result.type === "errored") return { ok: false, reason: "error", usage: null };
  const message = result.message;
  const usage = batchUsage(message.usage, message.model ?? NOTES_MODEL);
  if (message.stop_reason !== "end_turn") return { ok: false, reason: message.stop_reason === "refusal" ? "refusal" : "error", usage };
  const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  for (const candidate of texts.length > 1 ? [texts.join(""), texts[texts.length - 1]] : texts) {
    try {
      const parsed = ExtractAnswerSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return { ok: true, protocol: cleanExtraction(parsed.data, people, now), usage };
    } catch {
      // not JSON: try the next candidate
    }
  }
  return { ok: false, reason: "malformed", usage };
}

/** Anthropic's request_counts → ours (the shape stored on the job). */
export const countsOf = (b: MessageBatch) => ({
  processing: b.request_counts.processing,
  succeeded: b.request_counts.succeeded,
  errored: b.request_counts.errored,
  canceled: b.request_counts.canceled,
  expired: b.request_counts.expired,
});
