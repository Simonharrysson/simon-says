// Shared by scripts/notes-replay.ts (one transcript, verbose) and scripts/notes-eval.ts (every
// fixture, a table): replay a transcript tick by tick through the real notes engine, then score the
// notes against the fixture's expected file. Scoring (notes-score.ts) is pure, so saved runs can be
// rescored for $0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { formatItem } from "@/lib/docs/notes";
import { churn, churnStrict, updateNotes, type NotesClient, type NotesUsage } from "@/lib/notes/engine";
import type { NotesItem, NotesOp, NotesSection } from "@/lib/notes/schema";
import type { Expected, TickItems } from "./notes-score";

export * from "./notes-score";

export interface Line {
  speaker: string;
  startMs: number;
  text: string;
}

export interface TickLog {
  tick: number;
  final: boolean;
  ops: NotesOp[];
  usage: NotesUsage;
  thinking: number | null;
  hit: number;
  churn: number | null;
  churnStrict: number | null;
  ms: number;
  stop: string | null;
  dropped: number;
  servedBy: string | null;
  items: NotesItem[];
}

export interface ReplayResult {
  lineCount: number;
  endMs: number;
  tickMs: number;
  tickCount: number;
  ranTicks: number;
  meetingHours: number;
  totalUsd: number;
  perHour: number;
  churns: number[];
  strictChurns: number[];
  medianChurn: number;
  medianStrictChurn: number;
  items: NotesItem[];
  log: TickLog[];
}

export function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const path = process.env.SIMON_SAYS_ENV ?? join(homedir(), "simon-says-private", ".env");
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2");
  }
  throw new Error(`ANTHROPIC_API_KEY not set and not in ${path}`);
}

export const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function loadLines(file: string): Line[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
    .sort((a, b) => a.startMs - b.startMs);
}

export function loadExpected(path: string): Expected {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Expected) : {};
}

/** One transcript block per tick of `tickMs` meeting time, as Task 10 builds them. */
export function buildBlocks(lines: Line[], tickMs: number): { blocks: string[]; endMs: number } {
  const endMs = lines.at(-1)!.startMs + 5000;
  const blocks: string[] = [];
  for (let t = 0; t < Math.ceil(endMs / tickMs); t++) {
    const chunk = lines.filter((l) => l.startMs >= t * tickMs && l.startMs < (t + 1) * tickMs);
    blocks.push(chunk.map((l) => `[${mmss(l.startMs)}] ${l.speaker}: ${l.text}`).join("\n"));
  }
  return { blocks, endMs };
}

const HEADINGS: [NotesSection, string][] = [
  ["attendees", "Närvarande"],
  ["decision", "Beslut"],
  ["action", "Att göra"],
  ["now", "Pågår nu"],
];

/** The notes tab as Task 9 renders it (header + headings + one line per item), plus human-typed lines. */
export function tabText(items: NotesItem[], humanLines: { section: NotesSection; line: string }[] = []): string {
  const out = ["● LIVE · uppdaterad –"];
  for (const [section, title] of HEADINGS) {
    out.push(title);
    for (const item of items.filter((i) => i.section === section)) out.push(formatItem(item));
    for (const h of humanLines.filter((h) => h.section === section)) out.push(h.line);
  }
  return out.join("\n");
}

export function opLine(op: NotesOp): string {
  if (op.op === "remove") return `- remove ${op.id}`;
  if (op.op === "add") return `+ ${op.item.id} [${op.item.section}] ${formatItem(op.item)}`;
  const parts = (["text", "owner", "due"] as const).filter((k) => op[k] !== undefined).map((k) => `${k}=${JSON.stringify(op[k])}`);
  return `~ ${op.id} ${parts.join(" ")}`;
}

/** The real SDK client, wrapped so the caller sees each raw message (thinking tokens, serving model). */
export function makeClient(onMessage: (m: BetaMessage) => void): NotesClient {
  const sdk = new Anthropic({ apiKey: apiKey(), timeout: 120_000, maxRetries: 2 });
  return {
    beta: {
      messages: {
        stream: (body) => {
          const s = sdk.beta.messages.stream(body);
          return {
            finalMessage: async () => {
              const m = (await s.finalMessage()) as BetaMessage;
              onMessage(m);
              return m;
            },
          };
        },
      },
    },
  };
}

/**
 * Replay `lines` through the engine: one call per tick (transcript so far), then a final pass when
 * every tick ran. `onTick` sees each tick as it finishes (printing, spend ledger; throw to abort).
 */
export async function runReplay(opts: {
  lines: Line[];
  expected: Expected;
  tickMs: number;
  maxTicks?: number;
  realtime?: boolean;
  speed?: number;
  onTick?: (t: TickLog) => void;
}): Promise<ReplayResult> {
  const { lines, expected, tickMs } = opts;
  const { blocks: blocksAll, endMs } = buildBlocks(lines, tickMs);
  const tickCount = blocksAll.length;
  // Holder (not a plain `let`): TypeScript does not see the callback assign it.
  const seen: { last?: BetaMessage } = {};
  const client = makeClient((m) => (seen.last = m));

  let items: NotesItem[] = [];
  let nextId: string | undefined;
  const log: TickLog[] = [];
  const churns: number[] = [];
  const strictChurns: number[] = [];
  let totalUsd = 0;
  const ranTicks = Math.min(tickCount, opts.maxTicks ?? Infinity);
  const plan = [
    ...Array.from({ length: ranTicks }, (_, i) => ({ n: i + 1, final: false })),
    ...(ranTicks === tickCount ? [{ n: tickCount + 1, final: true }] : []),
  ];

  for (const step of plan) {
    if (opts.realtime && step.n > 1 && !step.final) await new Promise((r) => setTimeout(r, tickMs / (opts.speed ?? 1)));
    const atMs = Math.min(step.n, tickCount) * tickMs;
    const human = (expected.human_lines ?? []).filter((h) => h.atMs < atMs);
    const prev = items;
    const t0 = Date.now();
    seen.last = undefined;
    const out = await updateNotes(
      {
        orgName: expected.orgName ?? "Föreningen",
        transcriptBlocks: blocksAll.slice(0, Math.min(step.n, tickCount)),
        speakerNames: expected.speakerNames ?? {},
        notesTabText: tabText(items, human),
        items,
        locked: [],
        deletedIds: [],
        final: step.final,
        nextId,
      },
      { client },
    );
    const msg = seen.last as BetaMessage | undefined;
    items = out.items;
    nextId = out.nextId;
    const u = out.usage;
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    const c = prev.length ? churn(prev, items, []) : null;
    const cs = prev.some((i) => i.section !== "now") ? churnStrict(prev, items, []) : null;
    if (!step.final && c !== null) churns.push(c);
    if (!step.final && cs !== null) strictChurns.push(cs);
    totalUsd += u.usd;
    const t: TickLog = {
      tick: step.n,
      final: step.final,
      ops: out.ops,
      usage: u,
      thinking: msg?.usage.output_tokens_details?.thinking_tokens ?? null,
      hit: prompt ? u.cacheRead / prompt : 0,
      churn: c,
      churnStrict: cs,
      ms: Date.now() - t0,
      stop: out.stopReason,
      dropped: out.dropped,
      servedBy: msg?.model ?? null,
      items,
    };
    log.push(t);
    opts.onTick?.(t);
  }

  const meetingHours = (ranTicks * tickMs) / 3_600_000;
  return {
    lineCount: lines.length,
    endMs,
    tickMs,
    tickCount,
    ranTicks,
    meetingHours,
    totalUsd,
    perHour: totalUsd / meetingHours,
    churns,
    strictChurns,
    medianChurn: median(churns),
    medianStrictChurn: median(strictChurns),
    items,
    log,
  };
}

/** Each tick's items with the meeting time its transcript reaches (the final pass: the end). */
export function ticksOf(r: Pick<ReplayResult, "log" | "tickMs" | "tickCount" | "endMs">): TickItems[] {
  return r.log.map((t) => ({ items: t.items, atMs: t.final ? r.endMs : Math.min(t.tick, r.tickCount) * r.tickMs }));
}

// ---------------------------------------------------------------------------------------------
// Spend ledger (across runs): .notes-replay/spend.json

const LEDGER = join(".notes-replay", "spend.json");

export function ledgerTotal(): number {
  if (!existsSync(LEDGER)) return 0;
  return (JSON.parse(readFileSync(LEDGER, "utf8")) as { totalUsd: number }).totalUsd;
}

export function ledgerAdd(usd: number): number {
  mkdirSync(".notes-replay", { recursive: true });
  const total = ledgerTotal() + usd;
  writeFileSync(LEDGER, JSON.stringify({ totalUsd: total, updated: new Date().toISOString() }, null, 2));
  return total;
}
