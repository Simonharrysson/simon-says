/**
 * The feature suite (docs/superpowers/specs/2026-11-26-feature-test-suite-design.md): one command
 * that says, per feature, whether it still works.
 *
 *   npm run suite                               # free: vitest on tests/suite + the tagged tests, scorecard
 *   npm run suite -- --paid --budget 1.50       # + the real-Claude notes-eval fixtures of each feature
 *   npm run suite -- --paid-from <eval dir>     # $0: score a saved notes-eval run (.notes-replay/eval-*) instead
 *
 * Free tier: scripted Claude answers through the real code, docsim Docs; the DB tests skip without
 * the local Supabase stack (CI runs them). Paid tier: `notes-eval --only <the features' fixtures>`
 * on the ledger .notes-replay/spend-formats.json. `--budget` is what THIS run may add (default
 * $1.50): the ledger cap passed to notes-eval is the ledger total so far plus the budget. A paid
 * run reads ANTHROPIC_API_KEY like notes-eval does, and never starts from the free tier alone.
 *
 * Exit 1 when a feature FAILs (free tier, or a paid fixture's bars when --paid ran).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ledgerTotal } from "./lib/notes-run";
import { formatScorecard, paidFixtures, scorecard, suiteFiles, withPaid, type EvalRun, type VitestReport } from "./lib/suite-score";

const LEDGER = join(".notes-replay", "spend-formats.json");
const DEFAULT_BUDGET = 1.5;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function freeTier() {
  const out = join(mkdtempSync(join(tmpdir(), "suite-")), "vitest.json");
  const files = suiteFiles();
  console.log(`free tier: vitest on ${files.length} paths (tests/suite + tagged tests)\n`);
  const res = spawnSync("npx", ["vitest", "run", ...files, "--reporter=dot", "--reporter=json", `--outputFile.json=${out}`], { stdio: "inherit" });
  let report: VitestReport;
  try {
    report = JSON.parse(readFileSync(out, "utf8")) as VitestReport;
  } catch {
    console.error(`suite: vitest wrote no report (exit ${res.status})`);
    process.exit(1);
  }
  return scorecard(report, resolve("."));
}

/** notes-eval on the features' fixtures; returns the saved run directory. */
function paidTier(budget: number): string {
  const spent = ledgerTotal(LEDGER);
  const cap = spent + budget;
  const fixtures = paidFixtures();
  console.log(`\npaid tier: notes-eval --only ${fixtures.join(",")}`);
  console.log(`ledger ${LEDGER}: $${spent.toFixed(4)} spent so far; this run may add $${budget.toFixed(2)} (cap $${cap.toFixed(4)})\n`);
  const res = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "scripts/notes-eval.ts", "--only", fixtures.join(","), "--ledger", LEDGER, "--budget", cap.toFixed(4), "--label", "suite"],
    { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
  );
  process.stdout.write(res.stdout ?? "");
  const dir = /^saved: (.+)$/m.exec(res.stdout ?? "")?.[1];
  if (res.status !== 0 || !dir) {
    console.error(`suite: notes-eval failed (exit ${res.status})`);
    process.exit(1);
  }
  return dir.trim();
}

function main() {
  let rows = freeTier();
  const from = arg("paid-from");
  if (process.argv.includes("--paid") || from) {
    const dir = from ?? paidTier(Number(arg("budget") ?? DEFAULT_BUDGET));
    const runs = (JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { runs: EvalRun[] }).runs;
    rows = withPaid(rows, runs);
    console.log(`\npaid results: ${dir}`);
  }
  console.log(`\nFeature scorecard\n\n${formatScorecard(rows)}\n`);
  const failed = rows.filter((r) => !r.pass || (r.paid ?? []).some((p) => !p.pass));
  process.exit(failed.length ? 1 : 0);
}

main();
