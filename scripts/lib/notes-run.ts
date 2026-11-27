// Shared by scripts/notes-replay.ts (one transcript, verbose) and scripts/notes-eval.ts (every
// fixture, a table): replay a transcript tick by tick through the real notes engine, then score the
// notes against the fixture's expected file. Scoring (notes-score.ts) is pure, so saved runs can be
// rescored for $0.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CheckinWindow } from "@/lib/db/types";
import { formatLine } from "@/lib/docs/format-render";
import { formatItem } from "@/lib/docs/notes";
import { meetingRoles } from "@/lib/formats/schema";
import { FORMAT_NAMES, STANDARD } from "@/lib/formats/standard";
import { checkinSpan, endPassWindow, type SegmentRead } from "@/lib/meetings/tick";
import type { AgendaContext } from "@/lib/notes/agenda-prompt";
import { detectCheckin, maskCheckin, nextWindow, type CheckinFound } from "@/lib/notes/checkin";
import { churn, churnStrict, updateNotes, type NotesClient, type NotesUsage } from "@/lib/notes/engine";
import type { NotesItem, NotesOp, NotesSection } from "@/lib/notes/schema";
import { ownerLabel, resolveOwner } from "@/lib/people/roles";
import { rolePeople, type Expected, type TickItems } from "./notes-score";

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
  /** Agenda mode: the Må-runda detector's cost this tick (counted in `totalUsd` and the ledger). */
  checkinUsd?: number;
  /** Agenda mode: the Må-runda window after this tick. */
  window?: CheckinWindow | null;
  /** Agenda mode: no notes call this tick: "held" (window open, start unknown) or "idle" (no new lines). */
  skipped?: "held" | "idle";
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
  /** Agenda mode: the run hid the Må-runda (opt-in, the format's `hideCheckin`). Absent = off. */
  hideCheckin?: boolean;
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
  const { chunks, endMs } = chunkLines(lines, tickMs);
  return { blocks: chunks.map(blockText), endMs };
}

/** The lines of each tick of `tickMs` meeting time. */
export function chunkLines(lines: Line[], tickMs: number): { chunks: Line[][]; endMs: number } {
  const endMs = lines.at(-1)!.startMs + 5000;
  const chunks: Line[][] = [];
  for (let t = 0; t < Math.ceil(endMs / tickMs); t++) {
    chunks.push(lines.filter((l) => l.startMs >= t * tickMs && l.startMs < (t + 1) * tickMs));
  }
  return { chunks, endMs };
}

const blockText = (chunk: Line[]) => chunk.map((l) => `[${mmss(l.startMs)}] ${l.speaker}: ${l.text}`).join("\n");

/** The fixture's agenda as the plain lines of the agenda Doc (labels and their sub lines). */
export function agendaDocLines(expected: Expected): string[] {
  return (expected.agenda?.items ?? []).flatMap((a) => [a.label, ...(a.sub ?? [])]);
}

/** The fixture's standard format (Veckomöte unless the expected file names another). */
const profileOf = (expected: Expected) => STANDARD[expected.agenda?.profile ?? "veckomote"];

/** The notes tab in agenda mode: the agenda Doc's lines, then our items as the format renderer writes them, then human lines. */
export function agendaTabText(
  expected: Expected,
  items: NotesItem[],
  humanLines: { section: NotesSection; line: string }[] = [],
): { text: string; ownLines: string[] } {
  const people = rolePeople(expected);
  const label = (owner: string) => ownerLabel(resolveOwner(owner, people), owner, "role");
  const own = items.map((i) => formatLine(i, { profile: profileOf(expected), ownerLabel: label }));
  return { text: [...agendaDocLines(expected), ...own, ...humanLines.map((h) => h.line)].join("\n"), ownLines: own };
}

/** What the notes engine is told about the agenda (the tick's agendaContext, from the fixture). */
export function agendaContextOf(expected: Expected, opts: { hideCheckin?: boolean } = {}): AgendaContext {
  const profile = profileOf(expected);
  // As the start (meetingRoles): the Må-runda keeps its checkin role only when hiding is opted in.
  const roles = meetingRoles(Object.fromEntries((expected.agenda?.items ?? []).map((a) => [a.key, a.role])), { hideCheckin: opts.hideCheckin });
  return {
    formatName: FORMAT_NAMES[profile.kind],
    decisionPrefix: profile.decisionPrefix,
    groupBy: "role",
    numbering: profile.numbering,
    anchors: (expected.agenda?.items ?? []).map((a) => ({ key: a.key, label: a.label, role: roles[a.key], humanText: (a.sub ?? []).join("\n") })),
    people: (expected.people ?? []).map((p) => ({ name: p.name, role: p.role })),
  };
}

/** Last meeting's open tasks, pre-filled under the followup item as c1… (never Claude's to write). */
export function carriedItems(expected: Expected): NotesItem[] {
  const anchor = expected.agenda?.items.find((a) => a.role === "followup")?.key;
  return (expected.carried ?? []).map((c) => ({
    id: c.id,
    section: "action" as const,
    text: c.text,
    owner: c.owner,
    carried: true,
    ...(anchor ? { anchor } : {}),
  }));
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
  const parts = (["text", "owner", "due", "doneWhen"] as const).filter((k) => op[k] !== undefined).map((k) => `${k}=${JSON.stringify(op[k])}`);
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

/** Lines of the Må-runda detector's context (as the tick: the 20 lines before the new ones). */
const CHECKIN_CONTEXT_LINES = 20;

/**
 * Replay `lines` through the engine: one call per tick (transcript so far), then a final pass when
 * every tick ran. `onTick` sees each tick as it finishes (printing, spend ledger; throw to abort).
 *
 * `agenda: true` (a fixture with an agenda in its expected file) replays what lib/meetings/tick.ts
 * does in the format layout: the tab holds the agenda Doc's lines plus our items as the format
 * renderer writes them (`ownLines`), last meeting's tasks are pre-filled as c1…, and while the
 * Må-runda window is open (only with `hideCheckin`) the detector reads each tick's new lines (its cost is counted) and
 * `maskCheckin` replaces the window in that tick's block. While the window has no start and the
 * detector gave no answer the notes call is held (the lines wait for a later tick); the final
 * pass over-masks instead (`endPassWindow`). A tick with no new lines makes no call.
 */
export async function runReplay(opts: {
  lines: Line[];
  expected: Expected;
  tickMs: number;
  maxTicks?: number;
  realtime?: boolean;
  speed?: number;
  agenda?: true;
  /** Agenda mode: hide the Må-runda (detector + masking), as a format with `hideCheckin` does. Default off. */
  hideCheckin?: boolean;
  /** Tests: a fake client in place of the SDK. */
  client?: NotesClient;
  onTick?: (t: TickLog) => void;
}): Promise<ReplayResult> {
  const { lines, expected, tickMs } = opts;
  const agenda = opts.agenda && expected.agenda ? agendaContextOf(expected, { hideCheckin: opts.hideCheckin }) : null;
  const { chunks, endMs } = chunkLines(lines, tickMs);
  const blocksAll = chunks.map(blockText);
  const tickCount = chunks.length;
  // Holder (not a plain `let`): TypeScript does not see the callback assign it.
  const seen: { last?: BetaMessage } = {};
  const client = opts.client ?? makeClient((m) => (seen.last = m));

  let items: NotesItem[] = agenda ? carriedItems(expected) : [];
  let nextId: string | undefined;
  // Agenda mode: the Må-runda window (null without a checkin item, i.e. unless hiding is on) and how many ticks the notes engine has read.
  let win: CheckinWindow | null = agenda?.anchors.some((a) => a.role === "checkin") ? { startMs: null, endMs: null, closed: false, failures: 0 } : null;
  let sentTick = 0;
  const log: TickLog[] = [];
  const churns: number[] = [];
  const strictChurns: number[] = [];
  let totalUsd = 0;
  const ranTicks = Math.min(tickCount, opts.maxTicks ?? Infinity);
  const plan = [
    ...Array.from({ length: ranTicks }, (_, i) => ({ n: i + 1, final: false })),
    ...(ranTicks === tickCount ? [{ n: tickCount + 1, final: true }] : []),
  ];
  const zero: NotesUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const names = expected.speakerNames ?? {};
  const seg = (l: Line): SegmentRead => ({
    el_session_id: "eval",
    segment_index: 0,
    run_index: 0,
    speaker: l.speaker,
    text: l.text,
    start_ms: l.startMs,
    tick_no: 0,
    transcript_written_at: null,
  });
  const detLine = (l: Line) => ({ atMs: l.startMs, speaker: names[l.speaker] ?? l.speaker, text: l.text });

  for (const step of plan) {
    if (opts.realtime && step.n > 1 && !step.final) await new Promise((r) => setTimeout(r, tickMs / (opts.speed ?? 1)));
    const upTo = Math.min(step.n, tickCount);
    const atMs = upTo * tickMs;
    const human = (expected.human_lines ?? []).filter((h) => h.atMs < atMs);
    const prev = items;
    const t0 = Date.now();
    seen.last = undefined;

    // Agenda mode: the Må-runda detector on this tick's unsent lines, then hold / over-mask (tick.ts checkinStep).
    let checkinUsd = 0;
    let hold = false;
    const unsent = chunks.slice(sentTick, upTo).flat();
    if (agenda && win && !win.closed && unsent.length) {
      const earlier = chunks.slice(0, sentTick).flat();
      const span = checkinSpan(unsent.map(seg), earlier.map(seg));
      const res = await detectCheckin(
        {
          lines: unsent.map(detLine),
          context: earlier.slice(-CHECKIN_CONTEXT_LINES).map(detLine),
          agenda: agenda.anchors.map(({ key, label, role }) => ({ key, label, role })),
          window: win,
        },
        { orgId: "eval", client },
      );
      checkinUsd = res.usage?.usd ?? 0;
      const found: CheckinFound | "failed" = res.found;
      let next = nextWindow(win, found, span);
      if (found === "failed" && !next.closed && next.startMs === null) {
        if (step.final) next = endPassWindow(next, span);
        else hold = true;
      }
      win = next;
    }
    totalUsd += checkinUsd;
    seen.last = undefined;

    const noLines = step.final ? lines.length === 0 : unsent.length === 0;
    const skipped: TickLog["skipped"] = agenda ? (hold ? "held" : noLines ? "idle" : undefined) : undefined;
    let out: Awaited<ReturnType<typeof updateNotes>> | null = null;
    if (!skipped) {
      const blocks = agenda ? chunks.slice(0, upTo).map((c) => blockText(win ? maskCheckin(c, win, (l) => l.startMs) : c)) : blocksAll.slice(0, upTo);
      const tab = agenda ? agendaTabText(expected, items, human) : null;
      out = await updateNotes(
        {
          orgName: expected.orgName ?? "Föreningen",
          transcriptBlocks: blocks,
          speakerNames: names,
          notesTabText: tab ? tab.text : tabText(items, human),
          items,
          locked: [],
          deletedIds: [],
          final: step.final,
          nextId,
          ...(agenda && tab ? { agenda, ownLines: tab.ownLines } : {}),
        },
        { client },
      );
      if (agenda && out.stopReason !== "error") sentTick = upTo;
      items = out.items;
      nextId = out.nextId;
    }
    const msg = seen.last as BetaMessage | undefined;
    const u = out?.usage ?? zero;
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    const c = out && prev.length ? churn(prev, items, []) : null;
    const cs = out && prev.some((i) => i.section !== "now") ? churnStrict(prev, items, []) : null;
    if (!step.final && c !== null) churns.push(c);
    if (!step.final && cs !== null) strictChurns.push(cs);
    totalUsd += u.usd;
    const t: TickLog = {
      tick: step.n,
      final: step.final,
      ops: out?.ops ?? [],
      usage: u,
      thinking: msg?.usage.output_tokens_details?.thinking_tokens ?? null,
      hit: prompt ? u.cacheRead / prompt : 0,
      churn: c,
      churnStrict: cs,
      ms: Date.now() - t0,
      stop: out ? out.stopReason : (skipped ?? null),
      dropped: out?.dropped ?? 0,
      servedBy: msg?.model ?? null,
      items,
      ...(agenda ? { checkinUsd, window: win, ...(skipped ? { skipped } : {}) } : {}),
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
    ...(opts.hideCheckin ? { hideCheckin: true } : {}),
  };
}

/** Each tick's items with the meeting time its transcript reaches (the final pass: the end). */
export function ticksOf(r: Pick<ReplayResult, "log" | "tickMs" | "tickCount" | "endMs">): TickItems[] {
  return r.log.map((t) => ({ items: t.items, atMs: t.final ? r.endMs : Math.min(t.tick, r.tickCount) * r.tickMs }));
}

// ---------------------------------------------------------------------------------------------
// Spend ledger (across runs): .notes-replay/spend.json by default (notes-eval --ledger <file>)

export const DEFAULT_LEDGER = join(".notes-replay", "spend.json");

export function ledgerTotal(file: string = DEFAULT_LEDGER): number {
  if (!existsSync(file)) return 0;
  return (JSON.parse(readFileSync(file, "utf8")) as { totalUsd: number }).totalUsd;
}

export function ledgerAdd(usd: number, file: string = DEFAULT_LEDGER): number {
  mkdirSync(dirname(file), { recursive: true });
  const total = ledgerTotal(file) + usd;
  writeFileSync(file, JSON.stringify({ totalUsd: total, updated: new Date().toISOString() }, null, 2));
  return total;
}
