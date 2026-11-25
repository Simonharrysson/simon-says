/**
 * Notes-quality eval (Task Q): replay every fixture in fixtures/notes/ through the notes engine
 * (real Claude API, same logic as scripts/notes-replay.ts) and print one row per fixture against
 * the bars: median churn ≤ 15 %, recall 100 %, 0 must_not hits, ≤ $1.50 per meeting-hour.
 *
 *   npm run notes-eval -- [--only a,b] [--label before] [--concurrency 6] [--budget 5] [--tick-sec 45]
 *   npm run notes-eval -- --check            # $0: sanity-check every expected file
 *   npm run notes-eval -- --rescore <dir>    # $0: rescore a saved run with the current expected files
 *
 * Each run writes .notes-replay/eval-<label>-<time>/<fixture>.json (per-tick items, ops, usage) and
 * summary.json. Spend is added per tick to .notes-replay/spend.json; a run refuses to start, and
 * aborts, once that ledger passes --budget (USD, default 5).
 *
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env. Never prints it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  checkExpected,
  ledgerAdd,
  ledgerTotal,
  loadExpected,
  loadLines,
  mmss,
  runReplay,
  score,
  tabText,
  type Expected,
  type ReplayResult,
  type Score,
} from "./lib/notes-run";

const DIR = join("fixtures", "notes");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fixtures(): string[] {
  const all = readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"))
    .sort();
  const only = arg("only")?.split(",");
  return only ? all.filter((f) => only.includes(f)) : all;
}

const expectedOf = (name: string): Expected => loadExpected(join(DIR, `${name}.expected.json`));

interface Row {
  name: string;
  minutes: number;
  ticks: number;
  medianChurn: number;
  medianStrictChurn: number;
  usd: number;
  perHour: number;
  score: Score;
}

const pct = (x: number) => (Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);

function printTable(rows: Row[]) {
  const head = ["fixture", "min", "churn", "strict", "recall", "must_not", "(live)", "$", "$/h", "bars"];
  const body = rows.map((r) => {
    const ok = r.medianChurn <= 0.15 && r.score.found === r.score.total && r.score.mustNot.length === 0 && r.perHour <= 1.5;
    return [
      r.name,
      r.minutes.toFixed(1),
      pct(r.medianChurn),
      pct(r.medianStrictChurn),
      `${r.score.found}/${r.score.total}`,
      String(r.score.mustNot.length),
      String(r.score.mustNotLive.length),
      r.usd.toFixed(3),
      r.perHour.toFixed(2),
      ok ? "PASS" : "FAIL",
    ];
  });
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  const hours = rows.reduce((s, r) => s + r.minutes / 60, 0);
  const all = [...rows.map((r) => r.medianChurn)].sort((a, b) => a - b);
  const medAll = all.length ? (all.length % 2 ? all[(all.length - 1) / 2] : (all[all.length / 2 - 1] + all[all.length / 2]) / 2) : NaN;
  const found = rows.reduce((s, r) => s + r.score.found, 0);
  const total = rows.reduce((s, r) => s + r.score.total, 0);
  const hits = rows.reduce((s, r) => s + r.score.mustNot.length, 0);
  const live = rows.reduce((s, r) => s + r.score.mustNotLive.length, 0);
  const overallOk = rows.every((r) => r.medianChurn <= 0.15) && found === total && hits === 0 && totalUsd / hours <= 1.5;
  body.push([
    "ALL",
    (hours * 60).toFixed(1),
    pct(medAll),
    "",
    `${found}/${total}`,
    String(hits),
    String(live),
    totalUsd.toFixed(3),
    (totalUsd / hours).toFixed(2),
    overallOk ? "PASS" : "FAIL",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(fmt(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(fmt(b));
  console.log("\nchurn = median per-tick churn (plan metric); strict = text/owner/due/removals, 'now' excl.;");
  console.log("must_not = hits in the final notes (the bar); (live) = must_not items visible at some tick.");
}

function details(rows: Row[]) {
  for (const r of rows) {
    const bad = [...r.score.recall.filter((l) => l.startsWith("MISSING")), ...r.score.mustNot.map((l) => `MUST_NOT ${l}`)];
    const live = r.score.mustNotLive.filter((l) => !r.score.mustNot.some((m) => m.split(" ")[0] === l.split(" ")[0]));
    if (!bad.length && !live.length) continue;
    console.log(`\n${r.name}:`);
    for (const l of bad) console.log(`  ${l}`);
    for (const l of live) console.log(`  live only: ${l}`);
  }
}

function rowOf(name: string, r: Pick<ReplayResult, "ranTicks" | "tickMs" | "medianChurn" | "medianStrictChurn" | "totalUsd" | "perHour" | "items" | "log">): Row {
  return {
    name,
    minutes: (r.ranTicks * r.tickMs) / 60_000,
    ticks: r.ranTicks,
    medianChurn: r.medianChurn,
    medianStrictChurn: r.medianStrictChurn,
    usd: r.totalUsd,
    perHour: r.perHour,
    score: score(r.items, expectedOf(name), r.log),
  };
}

async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

async function main() {
  if (process.argv.includes("--check")) {
    let bad = 0;
    for (const name of fixtures()) {
      const e = expectedOf(name);
      const lines = loadLines(join(DIR, `${name}.jsonl`));
      const problems = checkExpected(e);
      const unknown = [...new Set(lines.map((l) => l.speaker))].filter((s) => !(e.speakerNames ?? {})[s]);
      if (unknown.length) problems.push(`speakers without a name: ${unknown.join(", ")}`);
      bad += problems.length;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${name}: ${lines.length} lines, ${mmss(lines.at(-1)!.startMs + 5000)}, ` +
        `${e.decisions?.length ?? 0} decisions, ${e.action_items?.length ?? 0} actions, ${e.must_not?.length ?? 0} must_not`);
      for (const p of problems) console.log(`     ${p}`);
    }
    process.exit(bad ? 1 : 0);
  }

  const rescore = arg("rescore");
  if (rescore) {
    const rows = readdirSync(rescore)
      .filter((f) => f.endsWith(".json") && f !== "summary.json")
      .map((f) => rowOf(basename(f, ".json"), JSON.parse(readFileSync(join(rescore, f), "utf8")) as ReplayResult))
      .filter((r) => fixtures().includes(r.name));
    printTable(rows);
    details(rows);
    return;
  }

  const budget = Number(arg("budget") ?? 5);
  const tickMs = Number(arg("tick-sec") ?? 45) * 1000;
  const label = arg("label") ?? "run";
  const names = fixtures();
  const spentBefore = ledgerTotal();
  if (spentBefore >= budget) throw new Error(`spend ledger $${spentBefore.toFixed(4)} ≥ budget $${budget}: not starting`);
  const outDir = join(".notes-replay", `eval-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`eval "${label}": ${names.length} fixtures, ledger $${spentBefore.toFixed(4)} of $${budget} → ${outDir}`);

  let aborted = false;
  const rows = await pool(
    names.map((name) => async () => {
      const expected = expectedOf(name);
      const r = await runReplay({
        lines: loadLines(join(DIR, `${name}.jsonl`)),
        expected,
        tickMs,
        onTick: (t) => {
          const spent = ledgerAdd(t.usage.usd);
          console.log(`[${name}] tick ${t.tick}${t.final ? " FINAL" : ""} ops=${t.ops.length} $${t.usage.usd.toFixed(4)} stop=${t.stop}  ledger $${spent.toFixed(4)}`);
          if (spent > budget) {
            aborted = true;
            throw new Error(`budget $${budget} exceeded (ledger $${spent.toFixed(4)})`);
          }
        },
      });
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ name, ...r }, null, 2));
      return rowOf(name, r);
    }),
    Number(arg("concurrency") ?? 6),
  );

  console.log("");
  for (const r of rows) {
    const saved = JSON.parse(readFileSync(join(outDir, `${r.name}.json`), "utf8")) as ReplayResult;
    console.log(`── ${r.name} final notes\n${tabText(saved.items, expectedOf(r.name).human_lines)}\n`);
  }
  printTable(rows);
  details(rows);
  const runUsd = rows.reduce((s, r) => s + r.usd, 0);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ label, runUsd, rows }, null, 2));
  console.log(`\nthis run $${runUsd.toFixed(4)}; ledger total $${ledgerTotal().toFixed(4)} of $${budget}${aborted ? " (ABORTED)" : ""}`);
  console.log(`saved: ${outDir}${existsSync(outDir) ? "" : " (missing)"}`);
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error("notes-eval failed:", e.status ?? "", e.message ?? err);
  process.exit(1);
});
