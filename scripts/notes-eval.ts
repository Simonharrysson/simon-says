/**
 * Notes-quality eval (Task Q): replay every fixture in fixtures/notes/ through the notes engine
 * (real Claude API, same logic as scripts/notes-replay.ts) and print one row per fixture against
 * the bars: median churn ≤ 15 %, recall 100 %, no must_not item in the final notes nor live for
 * 2+ ticks in a row, ≤ $1.75 per meeting-hour.
 *
 *   npm run notes-eval -- [--only a,b] [--repeat N] [--label before] [--concurrency 7] [--budget 5] [--tick-sec 45] [--hide-checkin]
 *   npm run notes-eval -- --check            # $0: sanity-check every expected file
 *   npm run notes-eval -- --rescore <dir>    # $0: rescore a saved run with the current expected files
 *
 * `--repeat N` replays each fixture N times; a fixture PASSES only if every run meets every bar.
 * The table shows the worst run per column. Each run writes .notes-replay/eval-<label>-<time>/
 * <fixture>[.r<k>].json (per-tick items, ops, usage) and summary.json. Spend is added per tick to
 * .notes-replay/spend.json; a run refuses to start, and aborts, once that ledger passes --budget
 * (USD, default 5). `--ledger <file>` keeps the ledger elsewhere (default .notes-replay/spend.json).
 *
 * Agenda fixtures (an `agenda` in the expected file, e.g. veckomote-a/-b) replay the format layout
 * (see runReplay: agenda Doc, owner roles, Från förra veckan) and add four bars: placement >= 90 %,
 * roles, followup and no leaks. The Må-runda is an ordinary item by default (as every format
 * now); `--hide-checkin` replays the opt-in (detector and masking, its cost counts) and then a
 * leak is also Må-runda content in the notes.
 *
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env. Never prints it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  checkExpected,
  DEFAULT_LEDGER,
  ledgerAdd,
  ledgerTotal,
  MAX_USD_PER_HOUR,
  loadExpected,
  loadLines,
  median,
  mmss,
  runReplay,
  score,
  scorePasses,
  tabText,
  ticksOf,
  type Expected,
  type ReplayResult,
  type Score,
} from "./lib/notes-run";

const DIR = join("fixtures", "notes");
const LEDGER = arg("ledger") ?? DEFAULT_LEDGER;

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

/** One replay of one fixture, scored. */
interface Run {
  name: string;
  minutes: number;
  medianChurn: number;
  medianStrictChurn: number;
  usd: number;
  perHour: number;
  score: Score;
}

type Saved = Pick<ReplayResult, "ranTicks" | "tickMs" | "tickCount" | "endMs" | "medianChurn" | "medianStrictChurn" | "totalUsd" | "perHour" | "items" | "log" | "hideCheckin">;

function runOf(name: string, r: Saved): Run {
  return {
    name,
    minutes: (r.ranTicks * r.tickMs) / 60_000,
    medianChurn: r.medianChurn,
    medianStrictChurn: r.medianStrictChurn,
    usd: r.totalUsd,
    perHour: r.perHour,
    score: score(r.items, expectedOf(name), ticksOf(r), { hideCheckin: r.hideCheckin }),
  };
}

const runPasses = (r: Run) => r.medianChurn <= 0.15 && r.perHour <= MAX_USD_PER_HOUR && scorePasses(r.score);
const pct = (x: number) => (Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const max = (xs: number[]) => Math.max(...xs);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const frac = (x: { ok: number; total: number }) => `${x.ok}/${x.total}`;
const worstOf = (rs: Run[], pick: (s: Score) => { ok: number; total: number }) =>
  rs.reduce((w, r) => (pick(r.score).ok - pick(r.score).total < pick(w.score).ok - pick(w.score).total ? r : w));

function printTable(runs: Run[]) {
  const names = [...new Set(runs.map((r) => r.name))];
  const agenda = runs.some((r) => expectedOf(r.name).agenda);
  const head = ["fixture", "min", "n", "churn", "strict", "recall", "must_not", "live2+", "(1 tick)", ...(agenda ? ["place", "roles", "followup", "leaks"] : []), "$", "$/h", "bars"];
  const body = names.map((n) => {
    const rs = runs.filter((r) => r.name === n);
    const worst = rs.reduce((w, r) => (r.score.found - r.score.total < w.score.found - w.score.total ? r : w));
    return [
      n,
      rs[0].minutes.toFixed(1),
      String(rs.length),
      pct(max(rs.map((r) => r.medianChurn))),
      pct(max(rs.map((r) => r.medianStrictChurn))),
      `${worst.score.found}/${worst.score.total}`,
      String(max(rs.map((r) => r.score.mustNot.length))),
      String(max(rs.map((r) => r.score.mustNotPersistent.length))),
      String(max(rs.map((r) => r.score.mustNotLive.length))),
      ...(agenda
        ? [
            frac(worstOf(rs, (s) => s.placement).score.placement),
            frac(worstOf(rs, (s) => s.roles).score.roles),
            frac(worstOf(rs, (s) => s.followup).score.followup),
            String(max(rs.map((r) => r.score.checkinLeaks.length))),
          ]
        : []),
      sum(rs.map((r) => r.usd)).toFixed(3),
      max(rs.map((r) => r.perHour)).toFixed(2),
      rs.every(runPasses) ? "PASS" : "FAIL",
    ];
  });
  // Overall: median of the per-run churn medians, counts summed over runs, $/h over all meeting time.
  const hours = sum(runs.map((r) => r.minutes / 60));
  body.push([
    "ALL",
    sum(names.map((n) => runs.find((r) => r.name === n)!.minutes)).toFixed(1),
    String(runs.length),
    pct(median(runs.map((r) => r.medianChurn))),
    "",
    `${sum(runs.map((r) => r.score.found))}/${sum(runs.map((r) => r.score.total))}`,
    String(sum(runs.map((r) => r.score.mustNot.length))),
    String(sum(runs.map((r) => r.score.mustNotPersistent.length))),
    String(sum(runs.map((r) => r.score.mustNotLive.length))),
    ...(agenda
      ? [
          frac({ ok: sum(runs.map((r) => r.score.placement.ok)), total: sum(runs.map((r) => r.score.placement.total)) }),
          frac({ ok: sum(runs.map((r) => r.score.roles.ok)), total: sum(runs.map((r) => r.score.roles.total)) }),
          frac({ ok: sum(runs.map((r) => r.score.followup.ok)), total: sum(runs.map((r) => r.score.followup.total)) }),
          String(sum(runs.map((r) => r.score.checkinLeaks.length))),
        ]
      : []),
    sum(runs.map((r) => r.usd)).toFixed(3),
    (sum(runs.map((r) => r.usd)) / hours).toFixed(2),
    runs.every(runPasses) ? "PASS" : "FAIL",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(fmt(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(fmt(b));
  console.log("\nn = runs; a fixture row shows its worst run (ALL: totals over all runs, median churn, $/h over all meeting time).");
  console.log("churn = median per-tick churn (plan metric); strict = text/owner/due/removals, 'now' excl.;");
  console.log("must_not = in the final notes; live2+ = live for 2+ ticks in a row (both fail the bar); (1 tick) = warning.");
  if (agenda) {
    console.log("place = decisions/tasks under the expected agenda item (bar >= 90 %); roles = owner shown by role; followup = Från förra veckan done flags;");
    console.log("leaks = items under a Från förra veckan item; with --hide-checkin also Må-runda content in the final or live notes or items under the Må-runda (all but place must be exact).");
  }
  console.log("PASS needs every run of the fixture to meet every bar.");
}

function details(runs: Run[]) {
  runs.forEach((r, i) => {
    const k = runs.slice(0, i).filter((x) => x.name === r.name).length + 1;
    const lines = [
      ...r.score.recall.filter((l) => l.startsWith("MISSING") || l.startsWith("WRONG")),
      ...r.score.checkinLeaks.map((l) => `LEAK ${l}`),
      ...r.score.mustNot.map((l) => `MUST_NOT ${l}`),
      ...r.score.mustNotPersistent.map((l) => `LIVE ${l}`),
      ...r.score.mustNotLive.map((l) => `warning ${l}`),
    ];
    if (!lines.length) return;
    console.log(`\n${r.name} run ${k}:`);
    for (const l of lines) console.log(`  ${l}`);
  });
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
      console.log(
        `${problems.length ? "FAIL" : "ok  "} ${name}: ${lines.length} lines, ${mmss(lines.at(-1)!.startMs + 5000)}, ` +
          `${e.decisions?.length ?? 0} decisions, ${e.action_items?.length ?? 0} actions, ${e.must_not?.length ?? 0} must_not` +
          (e.agenda ? `, agenda ${e.agenda.items.length} items, ${e.carried?.length ?? 0} carried` : ""),
      );
      for (const p of problems) console.log(`     ${p}`);
    }
    process.exit(bad ? 1 : 0);
  }

  const rescore = arg("rescore");
  if (rescore) {
    const runs = readdirSync(rescore)
      .filter((f) => f.endsWith(".json") && f !== "summary.json")
      .sort()
      .map((f) => {
        const saved = JSON.parse(readFileSync(join(rescore, f), "utf8")) as Saved & { endMs?: number };
        return runOf(basename(f, ".json").replace(/\.r\d+$/, ""), saved);
      })
      .filter((r) => fixtures().includes(r.name));
    printTable(runs);
    details(runs);
    return;
  }

  const budget = Number(arg("budget") ?? 5);
  const tickMs = Number(arg("tick-sec") ?? 45) * 1000;
  const label = arg("label") ?? "run";
  const repeat = Math.max(1, Number(arg("repeat") ?? 1));
  // Må-runda hiding is opt-in per format (default off); --hide-checkin replays the opt-in.
  const hideCheckin = process.argv.includes("--hide-checkin");
  const names = fixtures();
  const spentBefore = ledgerTotal(LEDGER);
  if (spentBefore >= budget) throw new Error(`spend ledger $${spentBefore.toFixed(4)} ≥ budget $${budget}: not starting`);
  const outDir = join(".notes-replay", `eval-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`eval "${label}": ${names.length} fixtures × ${repeat}, ledger ${LEDGER} $${spentBefore.toFixed(4)} of $${budget} → ${outDir}`);

  const jobs = names.flatMap((name) => Array.from({ length: repeat }, (_, k) => ({ name, k: k + 1 })));
  const done = await pool(
    jobs.map(({ name, k }) => async () => {
      const tag = repeat > 1 ? `${name}.r${k}` : name;
      const r = await runReplay({
        lines: loadLines(join(DIR, `${name}.jsonl`)),
        expected: expectedOf(name),
        tickMs,
        ...(expectedOf(name).agenda ? { agenda: true as const } : {}),
        hideCheckin,
        onTick: (t) => {
          const spent = ledgerAdd(t.usage.usd + (t.checkinUsd ?? 0), LEDGER);
          console.log(`[${tag}] tick ${t.tick}${t.final ? " FINAL" : ""} ops=${t.ops.length} $${(t.usage.usd + (t.checkinUsd ?? 0)).toFixed(4)} stop=${t.stop}  ledger $${spent.toFixed(4)}`);
          if (spent > budget) throw new Error(`budget $${budget} exceeded (ledger $${spent.toFixed(4)})`);
        },
      });
      writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ name, run: k, ...r }, null, 2));
      return { tag, run: runOf(name, r), items: r.items };
    }),
    Number(arg("concurrency") ?? 7),
  );

  console.log("");
  for (const { tag, items, run } of done)
    console.log(`── ${tag} final notes (human-typed lines included)\n${tabText(items, expectedOf(run.name).human_lines)}\n`);
  const runs = done.map((d) => d.run);
  printTable(runs);
  details(runs);
  const runUsd = sum(runs.map((r) => r.usd));
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ label, repeat, runUsd, runs }, null, 2));
  console.log(`\nthis run $${runUsd.toFixed(4)}; ledger total $${ledgerTotal(LEDGER).toFixed(4)} of $${budget}`);
  console.log(`saved: ${outDir}`);
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error("notes-eval failed:", e.status ?? "", e.message ?? err);
  process.exit(1);
});
