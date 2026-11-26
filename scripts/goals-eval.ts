/**
 * Goals-from-history eval (todo #7). Fictional protocol series (scripts/lib/goals-fixtures.ts:
 * 3 föreningar, 16–28 protocols each, goals that start, are achieved, dropped, go stale, are
 * renamed and revived) with ground-truth goals; deterministic grader (scripts/lib/goals-grade.ts).
 *
 *   npm run eval:goals                                  # $0 dry run: scripted answers (also in CI via vitest)
 *   npm run eval:goals -- --paid --budget 2.5 --stage digest [--only ridan,rutan]
 *   npm run eval:goals -- --paid --budget 2.5 --stage extract --only ridan [--protocols 0,6,14]
 *   npm run eval:goals -- --paid --budget 2.5 --stage e2e --only ridan     # extraction (cached) → digest
 *
 * Stages: digest = the digest over the ground-truth extraction (tests the temporal reasoning
 * alone); extract = one call per protocol, graded per protocol; e2e = the digest over the real
 * extraction (what an admin gets). Every paid response is cached in .notes-replay/goals-cache/
 * by request hash (a rerun with an unchanged prompt costs $0; --fresh ignores the cache). Spend
 * goes to the ledger .notes-replay/spend-goals.json (--ledger); a call is refused when the ledger
 * plus its estimate would pass --budget (USD, default 2.5). Runs are sequential. --cache-only
 * regrades saved answers and refuses any paid call.
 *
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env. Never prints it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { messageUsage, NOTES_MODEL, PRICES, type NotesClient } from "@/lib/notes/engine";
import { allSeries, type BuiltSeries } from "./lib/goals-fixtures";
import { hardSeries } from "./lib/goals-fixtures-hard";
import { flawedDigest, perfectDigest, perfectExtraction, scriptedClient } from "./lib/goals-scripted";
import { digestDetails, extractTable, runDigest, runExtraction, seriesDocs, summarize, totalsTable, truthHistory, type DigestRun, type ExtractRun } from "./lib/goals-eval";
import { apiKey, ledgerAdd, ledgerTotal } from "./lib/notes-run";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const LEDGER = arg("ledger") ?? join(".notes-replay", "spend-goals.json");
const CACHE = join(".notes-replay", "goals-cache");
const OUT = join(".notes-replay", "goals-eval");

/** Rough worst case of one call: input chars / 3 tokens, plus `outTokens` at the output price. */
const estimateUsd = (body: unknown, outTokens: number) => (JSON.stringify(body).length / 3) * (PRICES.input / 1e6) + outTokens * (PRICES.output / 1e6);

function paidClient(budget: number): NotesClient {
  const sdk = new Anthropic({ apiKey: apiKey(), timeout: 300_000, maxRetries: 1 });
  mkdirSync(CACHE, { recursive: true });
  return {
    beta: {
      messages: {
        stream: (body) => ({
          finalMessage: async () => {
            const key = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
            const file = join(CACHE, `${key}.json`);
            if (!flag("fresh") && existsSync(file)) {
              console.log(`  (cached ${key})`);
              return JSON.parse(readFileSync(file, "utf8")) as BetaMessage;
            }
            // Output: the largest measured was 3 652 (digest) and ~400 (extraction); twice that as the worst case.
            if (flag("cache-only")) throw new Error(`cache-only: no cached answer for ${key}`);
            const worst = estimateUsd(body, JSON.stringify(body).includes("historik") ? 8_000 : 1_500);
            const spent = ledgerTotal(LEDGER);
            if (spent + worst > budget) throw new Error(`budget: ledger $${spent.toFixed(4)} + estimate $${worst.toFixed(4)} > $${budget}`);
            const t0 = Date.now();
            const m = (await sdk.beta.messages.stream(body).finalMessage()) as BetaMessage;
            const usd = messageUsage(m.usage, m.model ?? NOTES_MODEL).usd;
            const total = ledgerAdd(usd, LEDGER);
            console.log(`  paid $${usd.toFixed(4)} (${m.usage.input_tokens} in, ${m.usage.output_tokens} out, ${((Date.now() - t0) / 1000).toFixed(0)} s, stop ${m.stop_reason}) ledger $${total.toFixed(4)}`);
            writeFileSync(file, JSON.stringify(m));
            return m;
          },
        }),
      },
    },
  };
}

function printDigest(label: string, runs: DigestRun[]) {
  console.log(`\n=== ${label}`);
  for (const r of runs) {
    if (!r.ok) console.log(`${r.slug}: FAILED (${r.error})`);
    else console.log(digestDetails(r.guarded!));
  }
  const { raw, guarded } = summarize(runs);
  console.log("\nraw (the model's own statuses):");
  console.log(totalsTable(raw));
  console.log("\nguarded (after the code's stale rule — what the admin sees):");
  console.log(totalsTable(guarded));
  console.log(`\ncode guard: ${runs.reduce((n, r) => n + r.demoted, 0)} current → stale, ${runs.reduce((n, r) => n + r.droppedEvidence, 0)} evidence lines with no meeting dropped`);
  console.log(`spend: $${runs.reduce((n, r) => n + r.usd, 0).toFixed(4)}`);
}

const FREE = { input_tokens: 0, output_tokens: 0 };

/** --set clean (4 föreningar), hard (2, real-looking minutes) or all (default). */
function seriesSet(): BuiltSeries[] {
  const set = arg("set") ?? "all";
  return set === "clean" ? allSeries() : set === "hard" ? hardSeries() : [...allSeries(), ...hardSeries()];
}

async function dry() {
  const series = seriesSet();
  const perfect: DigestRun[] = [];
  const flawed: DigestRun[] = [];
  for (const s of series) {
    perfect.push(await runDigest(s, truthHistory(s), scriptedClient([perfectDigest(s)], FREE)));
    flawed.push(await runDigest(s, truthHistory(s), scriptedClient([flawedDigest(s)], FREE)));
  }
  printDigest("DRY RUN: perfect scripted digest", perfect);
  printDigest("DRY RUN: flawed scripted digest (the grader must catch these)", flawed);
  const ex: ExtractRun[] = [];
  for (const s of series) {
    for (const p of s.protocols.slice(0, 3)) ex.push(await runExtraction(s, p, scriptedClient([perfectExtraction(p, s.allNames)], FREE)));
  }
  console.log("\n=== DRY RUN: scripted extraction");
  console.log(extractTable(ex));
  console.log("\nDry run: no Claude call was made ($0).");
}

async function paid() {
  const budget = Number(arg("budget") ?? 2.5);
  const stage = arg("stage") ?? "digest";
  const only = arg("only")?.split(",");
  const series = seriesSet().filter((s) => !only || only.includes(s.slug));
  const label = arg("label") ?? stage;
  const outDir = join(OUT, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`paid "${label}" stage ${stage}: ${series.map((s) => s.slug).join(", ")}; ledger ${LEDGER} $${ledgerTotal(LEDGER).toFixed(4)} of $${budget}`);
  const client = paidClient(budget);

  if (stage === "digest") {
    const runs: DigestRun[] = [];
    for (const s of series) {
      console.log(`digest ${s.slug} (${s.protocols.length} protocols)`);
      runs.push(await runDigest(s, truthHistory(s), client));
    }
    printDigest(`PAID digest over the ground-truth extraction`, runs);
    writeFileSync(join(outDir, "digest.json"), JSON.stringify(runs, null, 2));
  } else {
    const pick = arg("protocols")?.split(",").map(Number);
    const ex: ExtractRun[] = [];
    for (const s of series) {
      const docs = seriesDocs(s);
      if (!docs.ok) {
        console.log(`${s.slug}: running Doc NOT split (${docs.reason})`);
        continue;
      }
      if (s.runningDoc) console.log(`${s.slug}: one running Doc, split into ${docs.parts.length} meetings`);
      for (const part of docs.parts.filter((x) => !pick || pick.includes(x.protocol.index))) {
        console.log(`extract ${s.slug}#${part.protocol.index} (${part.text.length} chars)`);
        ex.push(await runExtraction(s, part.protocol, client, part));
      }
    }
    console.log("\n=== PAID extraction");
    console.log(extractTable(ex));
    for (const r of ex.filter((x) => x.grade && (x.grade.missing.length || x.grade.nameLeaks.length || !x.grade.dateOk))) {
      console.log(`${r.slug}#${r.index}: ${[...r.grade!.missing, ...r.grade!.nameLeaks.map((n) => `NAME ${n}`), ...(r.grade!.dateOk ? [] : [`DATE ${r.history?.date}`])].join(" | ")}`);
    }
    writeFileSync(join(outDir, "extract.json"), JSON.stringify(ex, null, 2));
    if (stage === "e2e") {
      const runs: DigestRun[] = [];
      for (const s of series) {
        const history = ex.filter((r) => r.slug === s.slug && r.history).map((r) => r.history!).sort((a, b) => a.date.localeCompare(b.date));
        console.log(`digest ${s.slug} over ${history.length} extracted protocols`);
        runs.push(await runDigest(s, history, client));
      }
      printDigest("PAID end to end (real extraction → digest)", runs);
      writeFileSync(join(outDir, "e2e.json"), JSON.stringify(runs, null, 2));
    }
  }
  console.log(`\nledger total $${ledgerTotal(LEDGER).toFixed(4)} of $${budget}; saved ${outDir}`);
}

(flag("paid") ? paid() : dry()).catch((err) => {
  console.error("eval:goals failed:", (err as Error).message);
  process.exit(1);
});
