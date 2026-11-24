/**
 * Task 8 early check: replay a transcript through the notes engine against the real Claude API.
 *
 *   npm run notes-replay -- <transcript.jsonl> [--expected <file>] [--tick-sec 45] [--ticks N]
 *                           [--realtime] [--speed 4]
 *
 * transcript.jsonl: one line per utterance, {"speaker":"S1-speaker_0","startMs":12345,"text":"…"}.
 * Lines are grouped into ticks of `--tick-sec` seconds of meeting time (one transcript block per
 * tick, as Task 10 will), then one final pass (`final: true`). `--ticks N` stops after N ticks
 * (smoke test; no final pass). Ticks run back to back unless `--realtime` (sleeps the tick spacing,
 * divided by `--speed`); the cache TTL is 5 min, so faster-than-real spacing does not change hits.
 *
 * `--expected` (default: <transcript>.expected.json next to the file, if present) gives orgName,
 * speakerNames and the decisions/actions to look for (each with `match`: groups of alternatives,
 * every group must hit, case-insensitive). Prints ops, tokens, cache hit rate and churn per tick,
 * then the final notes, recall, $ per meeting-hour and the gate. Full log → .notes-replay/.
 *
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env (SIMON_SAYS_ENV).
 * Never prints it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { formatItem } from "@/lib/docs/notes";
import { churn, updateNotes, type NotesClient } from "@/lib/notes/engine";
import type { NotesItem, NotesOp, NotesSection } from "@/lib/notes/schema";

interface Line {
  speaker: string;
  startMs: number;
  text: string;
}
interface Expected {
  orgName?: string;
  speakerNames?: Record<string, string>;
  decisions?: { key: string; text: string; match: string[][] }[];
  action_items?: { key: string; owner?: string; text: string; match: string[][] }[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const path = process.env.SIMON_SAYS_ENV ?? join(homedir(), "simon-says-private", ".env");
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2");
  }
  throw new Error(`ANTHROPIC_API_KEY not set and not in ${path}`);
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const HEADINGS: [NotesSection, string][] = [
  ["attendees", "Närvarande"],
  ["decision", "Beslut"],
  ["action", "Att göra"],
  ["now", "Pågår nu"],
];

/** The notes tab as Task 9 renders it (header + headings + one line per item). */
function tabText(items: NotesItem[]): string {
  const out = ["● LIVE · uppdaterad –"];
  for (const [section, title] of HEADINGS) {
    out.push(title);
    for (const item of items.filter((i) => i.section === section)) out.push(formatItem(item));
  }
  return out.join("\n");
}

function opLine(op: NotesOp): string {
  if (op.op === "remove") return `- remove ${op.id}`;
  if (op.op === "add") return `+ ${op.item.id} [${op.item.section}] ${formatItem(op.item)}`;
  const parts = (["text", "owner", "due"] as const).filter((k) => op[k] !== undefined).map((k) => `${k}=${JSON.stringify(op[k])}`);
  return `~ ${op.id} ${parts.join(" ")}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[   ]/g, " ")
    .replace(/(\d)[ .](?=\d{3}\b)/g, "$1");

function matches(text: string, groups: string[][]): boolean {
  const t = norm(text);
  return groups.every((alts) => alts.some((a) => t.includes(norm(a))));
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: notes-replay <transcript.jsonl> [options]");
  const tickMs = Number(arg("tick-sec") ?? 45) * 1000;
  const maxTicks = arg("ticks") ? Number(arg("ticks")) : Infinity;
  const realtime = process.argv.includes("--realtime");
  const speed = Number(arg("speed") ?? 1);
  const expectedPath = arg("expected") ?? file.replace(/\.jsonl$/, ".expected.json");
  const expected: Expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : {};

  const lines: Line[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
    .sort((a, b) => a.startMs - b.startMs);
  const endMs = lines.at(-1)!.startMs + 5000;
  const tickCount = Math.ceil(endMs / tickMs);
  const blocksAll: string[] = [];
  for (let t = 0; t < tickCount; t++) {
    const chunk = lines.filter((l) => l.startMs >= t * tickMs && l.startMs < (t + 1) * tickMs);
    blocksAll.push(chunk.map((l) => `[${mmss(l.startMs)}] ${l.speaker}: ${l.text}`).join("\n"));
  }

  // Wrap the real client to keep the raw message (thinking tokens, model that served it).
  const sdk = new Anthropic({ apiKey: apiKey(), timeout: 120_000, maxRetries: 2 });
  let last: BetaMessage | undefined;
  const client: NotesClient = {
    beta: {
      messages: {
        stream: (body) => {
          const s = sdk.beta.messages.stream(body);
          return {
            finalMessage: async () => {
              last = (await s.finalMessage()) as BetaMessage;
              return last;
            },
          };
        },
      },
    },
  };

  let items: NotesItem[] = [];
  const log: unknown[] = [];
  const churns: number[] = [];
  let totalUsd = 0;
  const runTicks = Math.min(tickCount, maxTicks);
  const plan = [...Array.from({ length: runTicks }, (_, i) => ({ n: i + 1, final: false })), ...(runTicks === tickCount ? [{ n: tickCount + 1, final: true }] : [])];
  console.log(`${basename(file)}: ${lines.length} lines, ${mmss(endMs)} meeting time, ${tickCount} ticks of ${tickMs / 1000}s + final`);

  for (const step of plan) {
    if (realtime && step.n > 1 && !step.final) await new Promise((r) => setTimeout(r, tickMs / speed));
    const blocks = blocksAll.slice(0, Math.min(step.n, tickCount));
    const prev = items;
    const t0 = Date.now();
    const out = await updateNotes(
      {
        orgName: expected.orgName ?? "Föreningen",
        transcriptBlocks: blocks,
        speakerNames: expected.speakerNames ?? {},
        notesTabText: tabText(items),
        items,
        locked: [],
        deletedIds: [],
        final: step.final,
      },
      { client },
    );
    const ms = Date.now() - t0;
    items = out.items;
    const u = out.usage;
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    const hit = prompt ? u.cacheRead / prompt : 0;
    const eligible = prev.filter((i) => i.section !== "now").length;
    const c = churn(prev, items, []);
    if (!step.final && eligible > 0) churns.push(c);
    totalUsd += u.usd;
    const thinking = last?.usage.output_tokens_details?.thinking_tokens ?? null;
    console.log(
      `\n── tick ${step.n}${step.final ? " (FINAL)" : ""} @ ${mmss(Math.min(step.n, tickCount) * tickMs)}  ` +
        `in=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} out=${u.output} (thinking ${thinking ?? "?"})  ` +
        `hit=${(hit * 100).toFixed(0)}%  $${u.usd.toFixed(4)}  churn=${eligible ? `${(c * 100).toFixed(0)}% of ${eligible}` : "–"}  ` +
        `${ms} ms  stop=${out.stopReason}${out.dropped ? ` dropped=${out.dropped}` : ""}${last && last.model !== "claude-opus-5-5" ? ` served-by=${last.model}` : ""}`,
    );
    for (const op of out.ops) console.log(`   ${opLine(op)}`);
    if (!out.ops.length) console.log("   (no ops)");
    log.push({ tick: step.n, final: step.final, ops: out.ops, usage: u, thinking, hit, churn: eligible ? c : null, ms, stop: out.stopReason, dropped: out.dropped, items });
  }

  console.log("\n══ final notes\n" + tabText(items));

  const meetingHours = (Math.min(runTicks, tickCount) * tickMs) / 3_600_000;
  const perHour = totalUsd / meetingHours;
  const med = median(churns);
  console.log(`\n══ results`);
  console.log(`cost: $${totalUsd.toFixed(4)} over ${(meetingHours * 60).toFixed(1)} min → $${perHour.toFixed(2)} per meeting-hour`);
  console.log(`churn per tick: ${churns.map((c) => `${(c * 100).toFixed(0)}%`).join(" ")}  median ${(med * 100).toFixed(1)}%`);
  const hits = (log as { hit: number }[]).map((l) => `${(l.hit * 100).toFixed(0)}%`);
  console.log(`cache hit rate per tick: ${hits.join(" ")}`);
  const tick2 = (log as { usage: { cacheRead: number } }[])[1];

  let found = 0;
  let total = 0;
  const recall: string[] = [];
  for (const d of expected.decisions ?? []) {
    total++;
    const hit = items.find((i) => i.section === "decision" && matches(i.text, d.match));
    if (hit) found++;
    recall.push(`${hit ? "FOUND  " : "MISSING"} ${d.key} ${d.text}${hit ? `  ← ${hit.id} "${hit.text}"` : ""}`);
  }
  for (const a of expected.action_items ?? []) {
    total++;
    const hit = items.find(
      (i) =>
        i.section === "action" &&
        matches(`${i.text} ${i.owner ?? ""}`, a.match) &&
        (!a.owner || norm(`${i.owner ?? ""} ${i.text}`).includes(norm(a.owner.split(" ")[0]))),
    );
    if (hit) found++;
    recall.push(`${hit ? "FOUND  " : "MISSING"} ${a.key} ${a.owner}: ${a.text}${hit ? `  ← ${hit.id} ${formatItem(hit)}` : ""}`);
  }
  console.log(`recall: ${found}/${total}`);
  for (const r of recall) console.log(`  ${r}`);

  console.log(`\n══ gate`);
  const pass = (ok: boolean) => (ok ? "PASS" : "FAIL");
  console.log(`${pass(med <= 0.15)} median churn ${(med * 100).toFixed(1)}% ≤ 15%`);
  if (total) console.log(`${pass(found === total)} all expected items found (${found}/${total})`);
  console.log(`${pass(perHour <= 1.5)} $${perHour.toFixed(2)} per meeting-hour ≤ $1.50`);
  if (tick2) console.log(`${pass(tick2.usage.cacheRead > 0)} cache_read_input_tokens > 0 from tick 2 (${tick2.usage.cacheRead})`);

  mkdirSync(".notes-replay", { recursive: true });
  const outFile = join(".notes-replay", `${basename(file, ".jsonl")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, JSON.stringify({ file, tickMs, totalUsd, perHour, medianChurn: med, churns, found, total, log }, null, 2));
  console.log(`\nlog: ${outFile}`);
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error("notes-replay failed:", e.status ?? "", e.message ?? err);
  process.exit(1);
});
