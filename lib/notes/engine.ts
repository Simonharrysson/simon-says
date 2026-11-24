import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { getEnv } from "@/lib/env";
import { SYSTEM_PROMPT, tailText, transcriptBlockText } from "@/lib/notes/prompt";
import { OPS_JSON_SCHEMA, OpsOutputSchema, toNotesOp, type NotesItem, type NotesOp } from "@/lib/notes/schema";

// The notes engine: transcript blocks + current notes → Claude → validated operations.
// Settings are fixed by the plan's global constraints (model, adaptive thinking by default,
// effort "medium" set explicitly, structured output via output_config.format, server-side
// fallbacks, stop_reason checked before content). Claude's output is never trusted: ops on
// locked or deleted ids, unknown ids, reused ids or a second "now" item are dropped here.

export const NOTES_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 16_000;

/** USD per million tokens, Claude Opus 5.5. Cache write = 1.25 × input (5-minute TTL). */
export const PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } as const;

export interface NotesUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

export interface UpdateNotesInput {
  orgName: string;
  /** One block per tick, oldest first, built from that tick's segments; never rewritten. */
  transcriptBlocks: string[];
  /** Speaker label (`S<session>-<label>`) → display name. */
  speakerNames: Record<string, string>;
  /** Full text of the notes tab, including lines people typed themselves (read-only context). */
  notesTabText: string;
  /** The service's own current items (not locked, not deleted). */
  items: NotesItem[];
  /** Human-edited items (disjoint from `items`, as `diffHumanEdits` returns them). Never touched. */
  locked: NotesItem[];
  /** Ids of items a human deleted. Never touched or reused. */
  deletedIds: string[];
  /** Meeting ended: a full tidy-up is allowed (locked/deleted stay untouchable). */
  final: boolean;
}

export interface UpdateNotesResult {
  ops: NotesOp[];
  /** `items` with the accepted ops applied. */
  items: NotesItem[];
  usage: NotesUsage;
  stopReason: string | null;
  /** Ops Claude returned that were rejected by validation. */
  dropped: number;
}

/** The slice of the SDK client the engine uses (so tests can pass a fake). */
export interface NotesClient {
  beta: {
    messages: {
      stream(body: BetaMessageStreamParams): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

let defaultClient: NotesClient | undefined;
function client(): NotesClient {
  defaultClient ??= new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });
  return defaultClient;
}

const ID = /^n(\d+)$/;

/** `n<max+1>` over every id ever used in this meeting (items, locked, deleted). */
export function nextItemId(ids: Iterable<string>): string {
  let max = 0;
  for (const id of ids) {
    const m = ID.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

export function usageCost(u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return (
    (u.input * PRICES.input + u.output * PRICES.output + u.cacheRead * PRICES.cacheRead + u.cacheWrite * PRICES.cacheWrite) /
    1_000_000
  );
}

/** The request body. Exported for tests and for the replay script's logging. */
export function buildRequest(input: UpdateNotesInput): BetaMessageStreamParams {
  const blocks = input.transcriptBlocks.map((b, i, all) => ({
    type: "text" as const,
    text: transcriptBlockText(b),
    // One breakpoint, on the newest transcript block: the next tick reads everything up to here.
    ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const allIds = [...input.items, ...input.locked].map((i) => i.id).concat(input.deletedIds);
  const tail = tailText({
    orgName: input.orgName,
    speakerNames: input.speakerNames,
    notesTabText: input.notesTabText,
    items: input.items,
    locked: input.locked,
    deletedIds: input.deletedIds,
    nextId: nextItemId(allIds),
    final: input.final,
  });
  return {
    model: NOTES_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: OPS_JSON_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [...blocks, { type: "text", text: tail }] }],
  };
}

/**
 * Apply ops in order to `items`, keeping only valid ones. Rules: never touch locked or deleted ids;
 * `change`/`remove` need an existing item; `add` needs a fresh `n<number>` id; a second "now" item
 * becomes a change of the existing one; a `change` that changes nothing is dropped.
 */
export function applyOps(
  items: NotesItem[],
  ops: NotesOp[],
  protectedIds: Iterable<string>,
): { ops: NotesOp[]; items: NotesItem[]; dropped: number } {
  const blocked = new Set(protectedIds);
  const used = new Set([...blocked, ...items.map((i) => i.id)]);
  let work = items.map((i) => ({ ...i }));
  const accepted: NotesOp[] = [];
  let dropped = 0;

  for (const op of ops) {
    if (op.op === "add") {
      const now = op.item.section === "now" ? work.find((i) => i.section === "now") : undefined;
      if (now) {
        // Exactly one "now" item: turn a second one into a change of the existing one.
        if (now.text === op.item.text) {
          dropped++;
          continue;
        }
        now.text = op.item.text;
        accepted.push({ op: "change", id: now.id, text: op.item.text });
        continue;
      }
      if (!ID.test(op.item.id) || used.has(op.item.id)) {
        dropped++;
        continue;
      }
      used.add(op.item.id);
      work.push({ ...op.item });
      accepted.push(op);
      continue;
    }
    const target = blocked.has(op.id) ? undefined : work.find((i) => i.id === op.id);
    if (!target) {
      dropped++;
      continue;
    }
    if (op.op === "remove") {
      work = work.filter((i) => i.id !== op.id);
      accepted.push(op);
      continue;
    }
    const before = JSON.stringify(target);
    if (op.text !== undefined) target.text = op.text;
    for (const key of ["owner", "due"] as const) {
      const value = op[key];
      if (value === undefined) continue;
      if (value) target[key] = value;
      else delete target[key];
    }
    if (JSON.stringify(target) === before) {
      dropped++;
      continue;
    }
    accepted.push(op);
  }
  return { ops: accepted, items: work, dropped };
}

/**
 * Churn = share of the existing, unedited items whose content changed (text, owner or due) or that
 * were removed between two ticks. The "now" item is excluded (it is meant to change with the topic)
 * and so are locked items. 0 when there is nothing to compare.
 */
export function churn(prev: NotesItem[], next: NotesItem[], locked: string[]): number {
  const skip = new Set(locked);
  const eligible = prev.filter((i) => i.section !== "now" && !skip.has(i.id));
  if (eligible.length === 0) return 0;
  const after = new Map(next.map((i) => [i.id, i]));
  const key = (i: NotesItem) => JSON.stringify([i.text, i.owner ?? "", i.due ?? ""]);
  const changed = eligible.filter((i) => {
    const n = after.get(i.id);
    return !n || key(n) !== key(i);
  });
  return changed.length / eligible.length;
}

function textOf(message: BetaMessage): string | null {
  // With fallbacks the content may hold `fallback` blocks; the answer is the last text block.
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (block.type === "text") return block.text;
  }
  return null;
}

export async function updateNotes(
  input: UpdateNotesInput,
  deps: { client?: NotesClient } = {},
): Promise<UpdateNotesResult> {
  const lockedIds = new Set(input.locked.map((i) => i.id));
  // Defensive: an id both in items and locked counts as locked (and is not ours to change).
  const items = input.items.filter((i) => !lockedIds.has(i.id) && !input.deletedIds.includes(i.id));
  const body = buildRequest({ ...input, items });

  const message = await (deps.client ?? client()).beta.messages.stream(body).finalMessage();

  const u = message.usage;
  const tokens = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  const usage: NotesUsage = { ...tokens, usd: usageCost(tokens) };
  const nothing = (dropped = 0): UpdateNotesResult => ({
    ops: [],
    items,
    usage,
    stopReason: message.stop_reason,
    dropped,
  });

  // stop_reason before content: a refusal (after any fallback) or a truncated answer gives no ops.
  if (message.stop_reason === "refusal") {
    console.warn("notes engine: refusal", message.stop_details?.category ?? null);
    return nothing();
  }
  if (message.stop_reason !== "end_turn") {
    console.error("notes engine: unexpected stop_reason", message.stop_reason);
    return nothing();
  }

  const text = textOf(message);
  let parsed: ReturnType<typeof OpsOutputSchema.safeParse> | undefined;
  try {
    parsed = text === null ? undefined : OpsOutputSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    // Log the shape problem only, never the content (it may quote the meeting).
    console.error("notes engine: malformed output", text === null ? "no text block" : `length ${text.length}`);
    return nothing();
  }

  const ops: NotesOp[] = [];
  let invalid = 0;
  for (const raw of parsed.data.ops) {
    const op = toNotesOp(raw);
    if (op) ops.push(op);
    else invalid++;
  }
  const applied = applyOps(items, ops, [...lockedIds, ...input.deletedIds]);
  const dropped = invalid + applied.dropped;
  if (dropped) console.warn(`notes engine: dropped ${dropped} of ${parsed.data.ops.length} ops`);
  return { ops: applied.ops, items: applied.items, usage, stopReason: message.stop_reason, dropped };
}
