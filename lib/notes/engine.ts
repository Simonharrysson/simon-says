import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { formatItem } from "@/lib/docs/notes";
import { getEnv } from "@/lib/env";
import { SYSTEM_PROMPT, tailText, transcriptBlockText } from "@/lib/notes/prompt";
import { OPS_JSON_SCHEMA, OpsOutputSchema, toNotesOp, type NotesItem, type NotesOp } from "@/lib/notes/schema";

// The notes engine: transcript blocks + current notes → Claude → validated operations.
// Settings are fixed by the plan's global constraints (model, adaptive thinking by default,
// effort "medium" set explicitly, structured output via output_config.format, server-side
// fallbacks, stop_reason checked before content). Claude's output is never trusted: ops on
// locked or deleted ids and unknown ids are dropped, new ids are assigned here, the "now" item is
// never removed outside the final pass, and mass removals/rewrites in one tick are capped
// (a transcript can carry "delete everything" — prompt injection or not).

export const NOTES_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 16_000;

/** Per non-final tick: at most this many removals of our own items, and this many text rewrites (not "now"). */
export const MAX_REMOVALS_PER_TICK = 2;
export const MAX_REWRITES_PER_TICK = 3;

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/**
 * USD per million tokens. Opus 5.5 from the model docs ($4/$20, cache read $0.20; cache write 1.25× input
 * at the 5-minute TTL). Fallback targets Opus 5 and Opus 4.8: $5/$25, cache read 0.1×, write 1.25×.
 */
export const MODEL_PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
export const PRICES = MODEL_PRICES[NOTES_MODEL];

export interface NotesUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  /** True when some tokens were priced at a guessed rate (unknown fallback model) or the call failed. */
  estimated?: boolean;
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
  /**
   * The meeting's id counter (`n<k>`), kept by the caller so an id is never reissued, even after the
   * service removed its own item. Missing → computed from items ∪ locked ∪ deletedIds.
   */
  nextId?: string;
}

export interface UpdateNotesResult {
  ops: NotesOp[];
  /** `items` with the accepted ops applied. */
  items: NotesItem[];
  usage: NotesUsage;
  /** Claude's stop_reason, or "error" when the request failed (network, timeout, API error). */
  stopReason: string | null;
  /** Ops Claude returned that were rejected by validation. */
  dropped: number;
  /** The id counter after this tick: store it and pass it back as `nextId`. */
  nextId: string;
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
const idNumber = (id: string | undefined) => {
  const m = id ? ID.exec(id) : null;
  return m ? Number(m[1]) : 0;
};

/** `n<max+1>` over every id ever used in this meeting (items, locked, deleted). */
export function nextItemId(ids: Iterable<string>): string {
  let max = 0;
  for (const id of ids) max = Math.max(max, idNumber(id));
  return `n${max + 1}`;
}

export function usageCost(
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
  price: Price = PRICES,
): number {
  return (
    (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/**
 * Tokens and cost of one response. With server-side fallbacks `usage.iterations` is the per-attempt
 * source of truth (top-level usage covers only the attempt that produced the message): every attempt
 * is summed and priced at its own model's rate; an unknown model is priced as Opus 5.5 and flagged.
 */
export function messageUsage(usage: BetaUsage, model: string): NotesUsage {
  const iterations = usage.iterations ?? [];
  const attempts: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }[] =
    iterations.length
      ? iterations.map((it) => ({ ...it, model: ("model" in it && it.model) || model }))
      : [{ ...usage, model }];
  const total: NotesUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  for (const a of attempts) {
    const t = {
      input: a.input_tokens ?? 0,
      output: a.output_tokens ?? 0,
      cacheRead: a.cache_read_input_tokens ?? 0,
      cacheWrite: a.cache_creation_input_tokens ?? 0,
    };
    const price = MODEL_PRICES[a.model];
    if (!price) total.estimated = true;
    total.input += t.input;
    total.output += t.output;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
    total.usd += usageCost(t, price ?? PRICES);
  }
  return total;
}

/** Notes-tab text without the lines that are exactly one of our own unlocked items (sent as JSON anyway). */
export function humanTabText(notesTabText: string, items: NotesItem[]): string {
  const ours = new Set(items.map((i) => formatItem(i).trim()));
  return notesTabText
    .split("\n")
    .filter((line) => !ours.has(line.trim()))
    .join("\n");
}

function effectiveNextId(input: Pick<UpdateNotesInput, "items" | "locked" | "deletedIds" | "nextId">): string {
  const computed = nextItemId([...input.items, ...input.locked].map((i) => i.id).concat(input.deletedIds));
  return idNumber(input.nextId) > idNumber(computed) ? input.nextId! : computed;
}

/** The request body. Exported for tests and for the replay script's logging. */
export function buildRequest(input: UpdateNotesInput): BetaMessageStreamParams {
  const blocks = input.transcriptBlocks.map((b, i, all) => ({
    type: "text" as const,
    text: transcriptBlockText(b, i + 1),
    // One breakpoint, on the newest transcript block: the next tick reads everything up to here.
    ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const tail = tailText({
    orgName: input.orgName,
    speakerNames: input.speakerNames,
    notesTabText: humanTabText(input.notesTabText, input.items),
    items: input.items,
    locked: input.locked,
    deletedIds: input.deletedIds,
    nextId: effectiveNextId(input),
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
 * Apply ops in order to `items`, keeping only valid ones:
 * - never touch protected (locked/deleted) ids; `change`/`remove` need an existing item;
 * - `add` gets the next server id (the model's id is ignored; later ops in the same batch that use
 *   the model's id are mapped to it); a second "now" item becomes a change of the existing one;
 * - outside the final pass: never remove the "now" item, at most MAX_REMOVALS_PER_TICK removals and
 *   MAX_REWRITES_PER_TICK text changes of other items;
 * - a `change` that changes nothing is dropped.
 */
export function applyOps(
  items: NotesItem[],
  ops: NotesOp[],
  opts: { protectedIds?: Iterable<string>; final?: boolean; nextId?: string } = {},
): { ops: NotesOp[]; items: NotesItem[]; dropped: number; nextId: string } {
  const blocked = new Set(opts.protectedIds ?? []);
  const final = opts.final ?? false;
  let counter = Math.max(idNumber(opts.nextId), idNumber(nextItemId([...blocked, ...items.map((i) => i.id)])));
  const assigned = new Map<string, string>();
  let work = items.map((i) => ({ ...i }));
  const accepted: NotesOp[] = [];
  let dropped = 0;
  let removals = 0;
  let rewrites = 0;

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
        assigned.set(op.item.id, now.id);
        accepted.push({ op: "change", id: now.id, text: op.item.text });
        continue;
      }
      const id = `n${counter++}`;
      assigned.set(op.item.id, id);
      const item = { ...op.item, id };
      work.push(item);
      accepted.push({ op: "add", item: { ...item } });
      continue;
    }
    const id = assigned.get(op.id) ?? op.id;
    const target = blocked.has(id) ? undefined : work.find((i) => i.id === id);
    if (!target) {
      dropped++;
      continue;
    }
    if (op.op === "remove") {
      if (!final && (target.section === "now" || removals >= MAX_REMOVALS_PER_TICK)) {
        dropped++;
        continue;
      }
      removals++;
      work = work.filter((i) => i.id !== id);
      accepted.push({ op: "remove", id });
      continue;
    }
    const rewrite = op.text !== undefined && op.text !== target.text && target.section !== "now";
    if (rewrite && !final && rewrites >= MAX_REWRITES_PER_TICK) {
      dropped++;
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
    if (rewrite) rewrites++;
    accepted.push({ ...op, id });
  }
  return { ops: accepted, items: work, dropped, nextId: `n${counter}` };
}

/**
 * Churn, the plan's metric (Task 0.5, gate): share of the existing, unedited (non-locked) items whose
 * TEXT changed between two ticks. The "now" item counts; removed and added items don't.
 */
export function churn(prev: NotesItem[], next: NotesItem[], locked: string[]): number {
  const skip = new Set(locked);
  const eligible = prev.filter((i) => !skip.has(i.id));
  if (eligible.length === 0) return 0;
  const after = new Map(next.map((i) => [i.id, i]));
  return eligible.filter((i) => after.has(i.id) && after.get(i.id)!.text !== i.text).length / eligible.length;
}

/**
 * Stricter variant (reported next to `churn`): excludes the "now" item, counts removals and any
 * change of text, owner or due.
 */
export function churnStrict(prev: NotesItem[], next: NotesItem[], locked: string[]): number {
  const skip = new Set(locked);
  const eligible = prev.filter((i) => i.section !== "now" && !skip.has(i.id));
  if (eligible.length === 0) return 0;
  const after = new Map(next.map((i) => [i.id, i]));
  const key = (i: NotesItem) => JSON.stringify([i.text, i.owner ?? "", i.due ?? ""]);
  return (
    eligible.filter((i) => {
      const n = after.get(i.id);
      return !n || key(n) !== key(i);
    }).length / eligible.length
  );
}

type ParsedOutput = { ok: true; ops: ReturnType<typeof OpsOutputSchema.parse>["ops"] } | { ok: false; why: string };

/** Parse the structured output: all text blocks joined in order; if that fails, the last one alone. */
function parseOutput(message: BetaMessage): ParsedOutput {
  const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  if (!texts.length) return { ok: false, why: "no text block" };
  const candidates = texts.length > 1 ? [texts.join(""), texts[texts.length - 1]] : texts;
  for (const candidate of candidates) {
    try {
      const parsed = OpsOutputSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return { ok: true, ops: parsed.data.ops };
    } catch {
      // not JSON: try the next candidate
    }
  }
  return { ok: false, why: `${texts.length} text block(s), length ${texts.join("").length}` };
}

export async function updateNotes(
  input: UpdateNotesInput,
  deps: { client?: NotesClient } = {},
): Promise<UpdateNotesResult> {
  const lockedIds = new Set(input.locked.map((i) => i.id));
  // Defensive: an id both in items and locked counts as locked (and is not ours to change).
  const items = input.items.filter((i) => !lockedIds.has(i.id) && !input.deletedIds.includes(i.id));
  const nextId = effectiveNextId({ ...input, items });
  const body = buildRequest({ ...input, items, nextId });

  let message: BetaMessage;
  try {
    message = await (deps.client ?? client()).beta.messages.stream(body).finalMessage();
  } catch (err) {
    // Network, timeout, 4xx/5xx after the SDK's retries: no ops this tick; the caller logs tick_failed.
    // A failed call reports no usage back, so it is recorded as 0 and flagged as estimated.
    const e = err as Error | undefined;
    console.error("notes engine: request failed", e?.constructor?.name ?? "Error", e?.message ?? String(err));
    return {
      ops: [],
      items,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, estimated: true },
      stopReason: "error",
      dropped: 0,
      nextId,
    };
  }

  const usage = messageUsage(message.usage, message.model ?? NOTES_MODEL);
  const nothing = (): UpdateNotesResult => ({ ops: [], items, usage, stopReason: message.stop_reason, dropped: 0, nextId });

  // stop_reason before content: a refusal (after any fallback) or a truncated answer gives no ops.
  if (message.stop_reason === "refusal") {
    console.warn("notes engine: refusal", message.stop_details?.category ?? null);
    return nothing();
  }
  if (message.stop_reason !== "end_turn") {
    console.error("notes engine: unexpected stop_reason", message.stop_reason);
    return nothing();
  }

  const parsed = parseOutput(message);
  if (!parsed.ok) {
    // Log the shape problem only, never the content (it may quote the meeting).
    console.error("notes engine: malformed output", parsed.why);
    return nothing();
  }

  const ops: NotesOp[] = [];
  let invalid = 0;
  for (const raw of parsed.ops) {
    const op = toNotesOp(raw);
    if (op) ops.push(op);
    else invalid++;
  }
  const applied = applyOps(items, ops, { protectedIds: [...lockedIds, ...input.deletedIds], final: input.final, nextId });
  const dropped = invalid + applied.dropped;
  if (dropped) console.warn(`notes engine: dropped ${dropped} of ${parsed.ops.length} ops`);
  return { ops: applied.ops, items: applied.items, usage, stopReason: message.stop_reason, dropped, nextId: applied.nextId };
}
