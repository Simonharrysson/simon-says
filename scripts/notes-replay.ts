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
 * speakerNames, the decisions/actions to look for (each with `match`: groups of alternatives,
 * every group must hit, case-insensitive), `must_not` items and human-typed `human_lines`. Prints
 * ops, tokens, cache hit rate and churn per tick, then the final notes, recall, must_not hits,
 * $ per meeting-hour and the gate. Full log → .notes-replay/. Spend is added to
 * .notes-replay/spend.json. All fixtures at once: scripts/notes-eval.ts.
 *
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env (SIMON_SAYS_ENV).
 * Never prints it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ledgerAdd, loadExpected, loadLines, mmss, opLine, runReplay, score, tabText, ticksOf } from "./lib/notes-run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: notes-replay <transcript.jsonl> [options]");
  const tickMs = Number(arg("tick-sec") ?? 45) * 1000;
  const expected = loadExpected(arg("expected") ?? file.replace(/\.jsonl$/, ".expected.json"));
  const lines = loadLines(file);
  const endMs = lines.at(-1)!.startMs + 5000;
  const tickCount = Math.ceil(endMs / tickMs);
  console.log(`${basename(file)}: ${lines.length} lines, ${mmss(endMs)} meeting time, ${tickCount} ticks of ${tickMs / 1000}s + final`);

  const r = await runReplay({
    lines,
    expected,
    tickMs,
    maxTicks: arg("ticks") ? Number(arg("ticks")) : undefined,
    realtime: process.argv.includes("--realtime"),
    speed: Number(arg("speed") ?? 1),
    ...(expected.agenda ? { agenda: true as const } : {}),
    onTick: (t) => {
      const u = t.usage;
      const spent = ledgerAdd(u.usd + (t.checkinUsd ?? 0));
      console.log(
        `\n── tick ${t.tick}${t.final ? " (FINAL)" : ""} @ ${mmss(Math.min(t.tick, tickCount) * tickMs)}  ` +
          `in=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} out=${u.output} (thinking ${t.thinking ?? "?"})  ` +
          `hit=${(t.hit * 100).toFixed(0)}%  $${u.usd.toFixed(4)}  churn=${t.churn !== null ? `${(t.churn * 100).toFixed(0)}%` : "–"} strict=${t.churnStrict !== null ? `${(t.churnStrict * 100).toFixed(0)}%` : "–"}  ` +
          `${t.ms} ms  stop=${t.stop}${t.dropped ? ` dropped=${t.dropped}` : ""}${t.servedBy && t.servedBy !== "claude-opus-5-5" ? ` served-by=${t.servedBy}` : ""}  ledger $${spent.toFixed(4)}`,
      );
      for (const op of t.ops) console.log(`   ${opLine(op)}`);
      if (!t.ops.length) console.log("   (no ops)");
    },
  });

  console.log("\n══ final notes\n" + tabText(r.items, expected.human_lines));
  const pct = (xs: number[]) => xs.map((c) => `${(c * 100).toFixed(0)}%`).join(" ");
  console.log(`\n══ results`);
  console.log(`cost: $${r.totalUsd.toFixed(4)} over ${(r.meetingHours * 60).toFixed(1)} min → $${r.perHour.toFixed(2)} per meeting-hour`);
  console.log(`churn per tick (plan metric, text, 'now' incl.): ${pct(r.churns)}  median ${(r.medianChurn * 100).toFixed(1)}%`);
  console.log(`strict churn per tick (text/owner/due/removals, 'now' excl.): ${pct(r.strictChurns)}  median ${(r.medianStrictChurn * 100).toFixed(1)}%`);
  console.log(`cache hit rate per tick: ${pct(r.log.map((l) => l.hit))}`);
  const s = score(r.items, expected, ticksOf(r));
  console.log(`recall: ${s.found}/${s.total}`);
  for (const line of s.recall) console.log(`  ${line}`);
  console.log(`must_not hits (final): ${s.mustNot.length}/${expected.must_not?.length ?? 0}`);
  for (const line of s.mustNot) console.log(`  HIT ${line}`);
  for (const line of s.mustNotPersistent) console.log(`  LIVE ${line}`);
  for (const line of s.mustNotLive) console.log(`  (warning, one tick) ${line}`);

  console.log(`\n══ gate`);
  const pass = (ok: boolean) => (ok ? "PASS" : "FAIL");
  const tick2 = r.log[1];
  console.log(`${pass(r.medianChurn <= 0.15)} median churn ${(r.medianChurn * 100).toFixed(1)}% ≤ 15%`);
  if (s.total) console.log(`${pass(s.found === s.total)} all expected items found (${s.found}/${s.total})`);
  if (expected.must_not?.length) console.log(`${pass(s.mustNot.length === 0)} no must_not item in the final notes`);
  if (expected.must_not?.length) console.log(`${pass(s.mustNotPersistent.length === 0)} no must_not item live for 2+ ticks in a row`);
  console.log(`${pass(r.perHour <= 1.5)} $${r.perHour.toFixed(2)} per meeting-hour ≤ $1.50`);
  if (tick2) console.log(`${pass(tick2.usage.cacheRead > 0)} cache_read_input_tokens > 0 from tick 2 (${tick2.usage.cacheRead})`);

  mkdirSync(".notes-replay", { recursive: true });
  const outFile = join(".notes-replay", `${basename(file, ".jsonl")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, JSON.stringify({ file, ...r, ...s }, null, 2));
  console.log(`\nlog: ${outFile}`);
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error("notes-replay failed:", e.status ?? "", e.message ?? err);
  process.exit(1);
});
