// The feature suite's scorecard (scripts/suite.ts), pure so it is unit-tested: which test files
// and paid-eval fixtures belong to which feature, and how a vitest JSON report and a notes-eval
// summary become one PASS/FAIL row per feature.

import { scorePasses, type Score } from "./notes-score";

export interface Feature {
  key: string;
  name: string;
  /** notes-eval fixtures (fixtures/notes/<name>.jsonl) the paid tier replays for this feature. */
  paid: string[];
}

/** Feature order of the scorecard. A suite test belongs to a feature by its describe title `feature: <key> …`. */
export const FEATURES: Feature[] = [
  { key: "formats", name: "Document formats", paid: ["veckomote-a", "styrelse-ekdala"] },
  { key: "transcription", name: "Transcription style", paid: ["owner-styles"] },
  { key: "voices", name: "Voices in each förening", paid: [] },
  { key: "chain", name: "Information from n meetings", paid: ["veckomote-b"] },
  { key: "safety", name: "Safety rails", paid: ["boardgames"] },
];

/**
 * Existing tests tagged to a feature (whole files): they run with tests/suite and count in that
 * feature's row. A file may serve several features.
 */
export const TAGGED_FILES: Record<string, string[]> = {
  formats: [
    "lib/agenda/anchor.test.ts",
    "lib/agenda/scan.test.ts",
    "lib/agenda/roles.test.ts",
    "lib/docs/format-render.test.ts",
    "lib/docs/skeleton.test.ts",
    "lib/formats/schema.test.ts",
    "lib/formats/skeleton.test.ts",
    "lib/formats/learn.test.ts",
    "lib/formats/stadgar.test.ts",
    "lib/formats/structure.test.ts",
    "lib/formats/editor.test.ts",
    "tests/api/formats.test.ts",
    "tests/db/formats.test.ts",
  ],
  transcription: ["lib/people/roles.test.ts", "lib/docs/transcript.test.ts", "scripts/lib/notes-score.test.ts"],
  voices: ["lib/names/extract.test.ts", "tests/meetings/name-round.test.ts", "tests/api/speakers.test.ts"],
  chain: ["lib/agenda/followup.test.ts", "tests/db/followup.test.ts", "lib/meetings/summary.test.ts"],
  safety: ["lib/docs/notes.test.ts", "lib/notes/checkin.test.ts", "lib/limits.test.ts", "tests/meetings/tick.test.ts", "tests/db/rls.test.ts"],
};

export const SUITE_DIR = "tests/suite";

/** Every test file the suite runs: tests/suite plus the tagged files. */
export const suiteFiles = (): string[] => [SUITE_DIR, ...new Set(Object.values(TAGGED_FILES).flat())];

/** The vitest JSON reporter's shape (the parts read here). */
export interface VitestReport {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { ancestorTitles: string[]; title: string; status: string; failureMessages?: string[] }[];
  }[];
}

export interface FeatureRow {
  key: string;
  name: string;
  passed: number;
  failed: number;
  skipped: number;
  /** Passing `it.fails` tests whose title starts with "BUG": known product bugs, pinned. */
  bugs: string[];
  files: string[];
  failures: string[];
  /** Free tier: no failure and at least one test ran. */
  pass: boolean;
  /** Paid tier: null when not run (or no fixture for the feature). */
  paid: { fixture: string; pass: boolean; detail: string }[] | null;
}

const rel = (file: string, root: string) => (file.startsWith(root) ? file.slice(root.length).replace(/^\/+/, "") : file);
const TAG = /^feature: ([a-z]+)\b/;

/** Free tier: one row per feature from a vitest JSON report. `root`: the repo path the report's file names start with. */
export function scorecard(report: VitestReport, root: string): FeatureRow[] {
  const rows = new Map<string, FeatureRow>(
    FEATURES.map((f) => [f.key, { key: f.key, name: f.name, passed: 0, failed: 0, skipped: 0, bugs: [], files: [], failures: [], pass: false, paid: null }]),
  );
  const addFile = (row: FeatureRow, file: string) => {
    if (!row.files.includes(file)) row.files.push(file);
  };
  for (const file of report.testResults) {
    const path = rel(file.name, root);
    const tagged = Object.entries(TAGGED_FILES)
      .filter(([, files]) => files.includes(path))
      .map(([k]) => k);
    // A suite file that failed to load has no tests: charge it to the feature its name says.
    if (!file.assertionResults.length && file.status === "failed") {
      const key = tagged[0] ?? /([a-z]+)\.test\.ts$/.exec(path)?.[1] ?? "";
      const row = rows.get(key);
      if (row) {
        row.failed++;
        row.failures.push(`${path}: ${(file.message ?? "failed to load").split("\n")[0]}`);
        addFile(row, path);
      }
      continue;
    }
    for (const t of file.assertionResults) {
      const own = t.ancestorTitles.map((a) => TAG.exec(a)?.[1]).find(Boolean);
      for (const key of own ? [own] : tagged) {
        const row = rows.get(key);
        if (!row) continue;
        addFile(row, path);
        if (t.status === "passed") {
          row.passed++;
          if (t.title.startsWith("BUG")) row.bugs.push(t.title);
        } else if (t.status === "failed") {
          row.failed++;
          row.failures.push(`${path} › ${[...t.ancestorTitles, t.title].join(" › ")}`);
        } else row.skipped++;
      }
    }
  }
  return [...rows.values()].map((r) => ({ ...r, pass: r.failed === 0 && r.passed > 0 }));
}

/** One notes-eval run as summary.json stores it. */
export interface EvalRun {
  name: string;
  medianChurn: number | null;
  perHour: number;
  score: Score;
}

/** notes-eval's bars (scripts/notes-eval.ts runPasses): churn ≤ 15 %, ≤ $1.50 per meeting-hour, every score bar. JSON null churn = NaN = fail, as there. */
export function evalRunPasses(r: EvalRun): boolean {
  const churn = r.medianChurn ?? NaN;
  return churn <= 0.15 && r.perHour <= 1.5 && scorePasses(r.score);
}

const pct = (x: { ok: number; total: number }) => `${x.ok}/${x.total}`;

/** Paid tier: each feature's fixtures from a notes-eval summary (a fixture passes only if every run does). */
export function withPaid(rows: FeatureRow[], runs: EvalRun[]): FeatureRow[] {
  return rows.map((row) => {
    const feature = FEATURES.find((f) => f.key === row.key)!;
    if (!feature.paid.length) return row;
    const paid = feature.paid.map((fixture) => {
      const mine = runs.filter((r) => r.name === fixture);
      if (!mine.length) return { fixture, pass: false, detail: "not run" };
      const worst = mine.find((r) => !evalRunPasses(r)) ?? mine[0];
      const s = worst.score;
      const detail = [
        `recall ${s.found}/${s.total}`,
        ...(s.placement.total ? [`place ${pct(s.placement)}`] : []),
        ...(s.roles.total ? [`roles ${pct(s.roles)}`] : []),
        ...(s.followup.total ? [`followup ${pct(s.followup)}`] : []),
        `must_not ${s.mustNot.length + s.mustNotPersistent.length}`,
        ...(s.checkinLeaks.length ? [`leaks ${s.checkinLeaks.length}`] : []),
        `churn ${worst.medianChurn === null ? "–" : `${(worst.medianChurn * 100).toFixed(0)}%`}`,
        `$${worst.perHour.toFixed(2)}/h`,
      ].join(", ");
      return { fixture, pass: mine.every(evalRunPasses), detail };
    });
    return { ...row, paid };
  });
}

/** All fixtures the paid tier replays, in feature order. */
export const paidFixtures = (): string[] => [...new Set(FEATURES.flatMap((f) => f.paid))];

/** The scorecard as text. */
export function formatScorecard(rows: FeatureRow[]): string {
  const paidRun = rows.some((r) => r.paid !== null);
  const head = ["feature", "free", "passed", "failed", "skipped", "bugs", ...(paidRun ? ["paid"] : [])];
  const body = rows.map((r) => [
    `${r.key} (${r.name})`,
    r.pass ? "PASS" : "FAIL",
    String(r.passed),
    String(r.failed),
    String(r.skipped),
    String(r.bugs.length),
    ...(paidRun ? [r.paid === null ? "–" : r.paid.every((p) => p.pass) ? "PASS" : "FAIL"] : []),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const out = [fmt(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(fmt)];
  const skipped = rows.reduce((s, r) => s + r.skipped, 0);
  if (skipped) out.push("", `skipped: ${skipped} tests need the local Supabase stack (they run in CI).`);
  for (const r of rows) {
    for (const f of r.failures) out.push(`FAIL ${r.key}: ${f}`);
    for (const b of r.bugs) out.push(`known bug (${r.key}): ${b}`);
    for (const p of r.paid ?? []) out.push(`paid ${r.key}: ${p.fixture} ${p.pass ? "PASS" : "FAIL"} (${p.detail})`);
  }
  return out.join("\n");
}
