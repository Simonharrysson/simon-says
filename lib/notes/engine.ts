import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ItemRole } from "@/lib/db/types";
import { formatItem } from "@/lib/docs/notes";
import { getEnv } from "@/lib/env";
import { cleanMeetingTitle } from "@/lib/meetings/title";
import { AGENDA_SYSTEM_PROMPT, AGENDA_SYSTEM_PROMPT_AGENT_TASKS, agendaTailText, type AgendaContext } from "@/lib/notes/agenda-prompt";
import { isAgentOwner } from "@/lib/agent/tasks";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_AGENT_TASKS, tailText, transcriptBlockText } from "@/lib/notes/prompt";
import {
  AGENDA_OPS_JSON_SCHEMA,
  AgendaOpsOutputSchema,
  OPS_JSON_SCHEMA,
  OpsOutputSchema,
  toAgendaOp,
  toNotesOp,
  type NotesItem,
  type NotesOp,
} from "@/lib/notes/schema";
import { resolveSources, type SourceIndex } from "@/lib/notes/sources";

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
  // Haiku 5.5 (cheap extraction, e.g. the board from a website): prompts ≤ 100K tokens.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
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
  /**
   * Agenda mode (meeting formats A8): the notes go under the agenda items of the förening's Doc.
   * Switches prompt, schema and tail, and adds the anchor rules to validation.
   */
  agenda?: AgendaContext;
  /**
   * Agenda mode: the text we last rendered for each of our rows (`last_rendered_text`, placement
   * prefix included). These lines are taken out of `notesTabText` so Claude never sees its own
   * lines as human text (F3).
   */
  ownLines?: string[];
  /**
   * "Claude ska …" agent tasks (0065), parked behind AGENT_TASKS_ENABLED: only when true does the
   * prompt tell Claude to give a task owner "Claude". Off (the default): the pre-0065 prompt, and
   * an assistant owner Claude still writes is dropped, so no new agent task is marked.
   */
  agentTasks?: boolean;
  /**
   * 0068: the transcript lines of `transcriptBlocks` by bracket time (buildTranscript's `sources`,
   * for exactly the blocks sent). Claude's cited times are resolved against it; without it every
   * citation is dropped (no link, never a wrong one).
   */
  sources?: SourceIndex;
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
  /**
   * Why this call gave no usable answer, or null when it did (an end_turn answer with zero ops is
   * a usable answer: nothing new to note). "error": the request failed; "refusal"; "stop:<reason>"
   * (e.g. max_tokens); "malformed": unparseable output; "all_dropped": every op was rejected.
   * The tick counts any non-null value as a failed tick for health (B1).
   */
  failure: string | null;
  /** The id counter after this tick: store it and pass it back as `nextId`. */
  nextId: string;
  /** Final pass only: the meeting's short title (0048), cleaned; absent when Claude gave none. Never logged. */
  title?: string;
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

/**
 * Notes-tab text without the lines that are exactly one of our own unlocked items (sent as JSON
 * anyway). v1 recognises them by `formatItem`; agenda mode passes `ownLines` (the rows'
 * `last_rendered_text`), since lines in a human Doc are rendered by the format renderer.
 */
export function humanTabText(notesTabText: string, items: NotesItem[], ownLines?: string[]): string {
  if (ownLines) return withoutOwnLines(notesTabText, ownLines);
  const ours = new Set(items.map((i) => formatItem(i).trim()).filter(Boolean));
  return notesTabText
    .split("\n")
    .filter((line) => !ours.has(line.trim()))
    .join("\n");
}

/** Spaces collapsed, NFC, and the (c)-style "– " placement prefix dropped: how own lines are compared. */
const ownKey = (line: string) =>
  line
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^– /, "");

/**
 * `text` without the lines that are one of `ownLines` (our rendered rows), compared with spaces
 * collapsed and with or without the "– " prefix (the scan's humanText collapses spaces). F3.
 */
export function withoutOwnLines(text: string, ownLines: string[]): string {
  const ours = new Set(ownLines.map(ownKey).filter(Boolean));
  if (!ours.size) return text;
  return text
    .split("\n")
    .filter((line) => !ours.has(ownKey(line)))
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
  const agenda = input.agenda;
  const tailInput = {
    orgName: input.orgName,
    speakerNames: input.speakerNames,
    notesTabText: agenda ? humanTabText(input.notesTabText, input.items, input.ownLines ?? []) : humanTabText(input.notesTabText, input.items),
    items: input.items,
    locked: input.locked,
    deletedIds: input.deletedIds,
    nextId: effectiveNextId(input),
    final: input.final,
  };
  // F3 per item: the scan's humanText also holds our own lines (and the carried c* lines).
  const own = input.ownLines ?? [];
  const tail = agenda
    ? agendaTailText({
        ...tailInput,
        agenda: { ...agenda, anchors: agenda.anchors.map((a) => ({ ...a, humanText: withoutOwnLines(a.humanText, own) })) },
      })
    : tailText(tailInput);
  return {
    model: NOTES_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: agenda ? AGENDA_OPS_JSON_SCHEMA : OPS_JSON_SCHEMA } },
    system: agenda ? (input.agentTasks ? AGENDA_SYSTEM_PROMPT_AGENT_TASKS : AGENDA_SYSTEM_PROMPT) : input.agentTasks ? SYSTEM_PROMPT_AGENT_TASKS : SYSTEM_PROMPT,
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
 * - a `change` that changes nothing is dropped;
 * - a `change` that moves an item to another anchor is dropped; a carried item (Från förra
 *   veckan) only takes `done` (no text/owner/due change, no removal); `done` only on tasks.
 *   A `done` change is not a rewrite;
 * - with `agenda` (agenda mode) an `add` also needs a known anchor (a live `ag-*` key in
 *   `agenda.anchors`, or `notes`) whose role is not `checkin` or `followup`, and a kind other than
 *   "now" or "attendees".
 */
export function applyOps(
  items: NotesItem[],
  ops: NotesOp[],
  opts: {
    protectedIds?: Iterable<string>;
    final?: boolean;
    nextId?: string;
    agenda?: { anchors: Map<string, ItemRole | "notes"> };
    /** 0068: cited bracket times → segments; see `UpdateNotesInput.sources`. */
    sources?: SourceIndex;
  } = {},
): { ops: NotesOp[]; items: NotesItem[]; dropped: number; nextId: string; ruled?: number; ignored: number } {
  const blocked = new Set(opts.protectedIds ?? []);
  const final = opts.final ?? false;
  let counter = Math.max(idNumber(opts.nextId), idNumber(nextItemId([...blocked, ...items.map((i) => i.id)])));
  const assigned = new Map<string, string>();
  let work = items.map((i) => ({ ...i }));
  const accepted: NotesOp[] = [];
  let dropped = 0;
  /** Adds dropped only because their item is the Må-runda or "Från förra veckan" (by design). */
  let ruled = 0;
  let removals = 0;
  let rewrites = 0;
  /** Citation-only changes that changed nothing (0068): neither accepted nor a rejection. */
  let ignored = 0;

  for (const op of ops) {
    if (op.op === "add" && opts.agenda && !agendaAddAllowed(op.item, opts.agenda.anchors)) {
      dropped++;
      const role = op.item.anchor ? opts.agenda.anchors.get(op.item.anchor) : undefined;
      if (role === "checkin" || role === "followup") ruled++;
      continue;
    }
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
      // Sources only from the server's resolution of the cited times (0068), never from the op.
      const { sources: _s, saidAtMs: _a, ...fields } = op.item;
      const src = sourced(fields.section) ? resolveSources(op.src, opts.sources) : null;
      const item: NotesItem = { ...fields, id, ...(src ? { sources: src.ids, saidAtMs: src.saidAtMs } : {}) };
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
      if (target.carried || (!final && (target.section === "now" || removals >= MAX_REMOVALS_PER_TICK))) {
        dropped++;
        continue;
      }
      removals++;
      work = work.filter((i) => i.id !== id);
      accepted.push({ op: "remove", id });
      continue;
    }
    const { src: cited, ...change } = op;
    const moves = change.anchor !== undefined && change.anchor !== target.anchor;
    const edits = change.text !== undefined || change.owner !== undefined || change.due !== undefined || change.doneWhen !== undefined;
    // done only on tasks; a carried task only ever takes done: true (never re-opened by Claude).
    const badDone = change.done !== undefined && (target.section !== "action" || (target.carried && change.done !== true));
    if (moves || badDone || (target.carried && edits)) {
      dropped++;
      continue;
    }
    const rewrite = change.text !== undefined && change.text !== target.text && target.section !== "now";
    if (rewrite && !final && rewrites >= MAX_REWRITES_PER_TICK) {
      dropped++;
      continue;
    }
    const before = JSON.stringify(target);
    if (change.text !== undefined) target.text = change.text;
    for (const key of ["owner", "due", "doneWhen"] as const) {
      const value = change[key];
      if (value === undefined) continue;
      if (value) target[key] = value;
      else delete target[key];
    }
    if (change.done === true) target.done = true;
    else if (change.done === false) delete target.done;
    // 0068: a cited moment is set where none is yet, or with a text the meeting changed; never on
    // a carried task (its moment is in another meeting).
    const src = cited && !target.carried && sourced(target.section) && (!target.sources?.length || rewrite) ? resolveSources(cited, opts.sources) : null;
    if (src) {
      target.sources = src.ids;
      target.saidAtMs = src.saidAtMs;
    }
    if (JSON.stringify(target) === before) {
      // A citation alone on an item that already has its moment is a quiet no-op, not a rejection.
      const onlyCited = cited && !edits && change.done === undefined && change.anchor === undefined;
      if (onlyCited) ignored++;
      else dropped++;
      continue;
    }
    if (rewrite) rewrites++;
    accepted.push({ ...change, id });
  }
  return { ops: accepted, items: work, dropped, nextId: `n${counter}`, ignored, ...(opts.agenda ? { ruled } : {}) };
}

/** Decisions and tasks carry a moment (0068); attendees, "now" and notes don't. */
const sourced = (section: NotesItem["section"]) => section === "decision" || section === "action";

/**
 * Agent tasks parked (AGENT_TASKS_ENABLED off): an owner that means the assistant ("Claude", "AI:n",
 * "Simon Says") is left out of an add and a change, so the row is never marked as Claude's task.
 */
export function withoutAgentOwners(ops: NotesOp[], people: string[] = []): NotesOp[] {
  // A real person in the meeting called that (a member named Claude) keeps their task, as before 0065.
  const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  const names = new Set(people.flatMap((p) => [norm(p), norm(p).split(" ")[0]]).filter(Boolean));
  const assistant = (owner: string | undefined) => isAgentOwner(owner) && !names.has(norm(owner!).replace(/[.:!]+$/, ""));
  return ops.map((op) => {
    if (op.op === "add" && assistant(op.item.owner)) {
      const { owner: _, ...item } = op.item;
      return { ...op, item };
    }
    if (op.op === "change" && assistant(op.owner)) {
      const { owner: _, ...rest } = op;
      return rest;
    }
    return op;
  });
}

/** An agenda-mode `add` is placed under a live agenda item or `notes`, never under checkin/followup. */
function agendaAddAllowed(item: NotesItem, anchors: Map<string, ItemRole | "notes">): boolean {
  if (item.section === "now" || item.section === "attendees") return false;
  const anchor = item.anchor;
  if (!anchor) return false;
  if (anchor === "notes") return true; // Ruling R-A7: every profile may carry a notes anchor.
  if (!anchor.startsWith("ag-")) return false;
  const role = anchors.get(anchor);
  return role !== undefined && role !== "checkin" && role !== "followup";
}

/**
 * The anchor map `applyOps` validates agenda-mode adds against: every live (not gone) agenda key
 * with its role, plus `notes` (Ruling R-A7).
 */
export function anchorRoles(agenda: AgendaContext): Map<string, ItemRole | "notes"> {
  const out = new Map<string, ItemRole | "notes">();
  for (const a of agenda.anchors) if (!a.gone) out.set(a.key, a.role);
  out.set("notes", "notes");
  return out;
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
 * change of text, owner, due or done_when.
 */
export function churnStrict(prev: NotesItem[], next: NotesItem[], locked: string[]): number {
  const skip = new Set(locked);
  const eligible = prev.filter((i) => i.section !== "now" && !skip.has(i.id));
  if (eligible.length === 0) return 0;
  const after = new Map(next.map((i) => [i.id, i]));
  const key = (i: NotesItem) => JSON.stringify([i.text, i.owner ?? "", i.due ?? "", i.doneWhen ?? ""]);
  return (
    eligible.filter((i) => {
      const n = after.get(i.id);
      return !n || key(n) !== key(i);
    }).length / eligible.length
  );
}

type ParsedOutput = { ok: true; ops: NotesOp[]; invalid: number; count: number; title?: string } | { ok: false; why: string };

/**
 * Parse the structured output: all text blocks joined in order; if that fails, the last one alone.
 * Raw ops are turned into NotesOps (v1 or agenda shape); incomplete ones count as invalid.
 */
function parseOutput(message: BetaMessage, agenda: boolean): ParsedOutput {
  const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  if (!texts.length) return { ok: false, why: "no text block" };
  const candidates = texts.length > 1 ? [texts.join(""), texts[texts.length - 1]] : texts;
  for (const candidate of candidates) {
    try {
      const json: unknown = JSON.parse(candidate);
      let converted: (NotesOp | null)[] | null = null;
      let title: string | undefined;
      if (agenda) {
        const parsed = AgendaOpsOutputSchema.safeParse(json);
        if (parsed.success) [converted, title] = [parsed.data.ops.map(toAgendaOp), parsed.data.title];
      } else {
        const parsed = OpsOutputSchema.safeParse(json);
        if (parsed.success) [converted, title] = [parsed.data.ops.map(toNotesOp), parsed.data.title];
      }
      if (!converted) continue;
      const ops = converted.filter((op): op is NotesOp => op !== null);
      return { ok: true, ops, invalid: converted.length - ops.length, count: converted.length, ...(title !== undefined ? { title } : {}) };
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
      failure: "error",
    };
  }

  const usage = messageUsage(message.usage, message.model ?? NOTES_MODEL);
  const nothing = (failure: string): UpdateNotesResult => ({
    ops: [],
    items,
    usage,
    stopReason: message.stop_reason,
    dropped: 0,
    nextId,
    failure,
  });

  // stop_reason before content: a refusal (after any fallback) or a truncated answer gives no ops.
  if (message.stop_reason === "refusal") {
    console.warn("notes engine: refusal", message.stop_details?.category ?? null);
    return nothing("refusal");
  }
  if (message.stop_reason !== "end_turn") {
    console.error("notes engine: unexpected stop_reason", message.stop_reason);
    return nothing(`stop:${message.stop_reason}`);
  }

  const parsed = parseOutput(message, Boolean(input.agenda));
  if (!parsed.ok) {
    // Log the shape problem only, never the content (it may quote the meeting).
    console.error("notes engine: malformed output", parsed.why);
    return nothing("malformed");
  }

  const applied = applyOps(items, input.agentTasks ? parsed.ops : withoutAgentOwners(parsed.ops, [...Object.values(input.speakerNames), ...(input.agenda?.people.map((p) => p.name) ?? [])]), {
    protectedIds: [...lockedIds, ...input.deletedIds],
    final: input.final,
    nextId,
    ...(input.agenda ? { agenda: { anchors: anchorRoles(input.agenda) } } : {}),
    ...(input.sources ? { sources: input.sources } : {}),
  });
  const dropped = parsed.invalid + applied.dropped;
  if (dropped) console.warn(`notes engine: dropped ${dropped} of ${parsed.count} ops`);
  // Ops came back but validation rejected every one: the notes didn't move although Claude meant
  // them to. Zero ops returned is fine (a quiet stretch).
  // Adds only under the Må-runda / "Från förra veckan" items (dropped by rule, R2-M3) are a quiet
  // tick too, not a failure.
  const onlyRuled = parsed.invalid === 0 && applied.dropped > 0 && applied.dropped === (applied.ruled ?? 0);
  const failure = parsed.count - applied.ignored > 0 && applied.ops.length === 0 && !onlyRuled ? "all_dropped" : null;
  // The title is only asked for in the final pass; a stray one on a live tick is ignored.
  const title = input.final ? cleanMeetingTitle(parsed.title) : null;
  return { ops: applied.ops, items: applied.items, usage, stopReason: message.stop_reason, dropped, nextId: applied.nextId, failure, ...(title ? { title } : {}) };
}
