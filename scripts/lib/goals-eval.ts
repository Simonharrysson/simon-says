// The goals-from-history eval's runner (todo #7), shared by scripts/goals-eval.ts and its
// vitest dry run. Digest: the series' history (ground-truth extraction, or a real extraction for
// the end-to-end stage) → digestGoals → graded raw (the model's own statuses) and guarded (after
// the code's stale rule). Extraction: protocol text → extractProtocol → graded per protocol.

import { digestGoals } from "@/lib/history/digest";
import { finalizeGoals } from "@/lib/history/digest-input";
import { splitProtocols } from "@/lib/history/doc-text";
import { extractProtocol } from "@/lib/history/extract";
import type { NotesClient, NotesUsage } from "@/lib/notes/engine";
import type { HistoryMeeting } from "@/lib/history/types";
import type { BuiltSeries, FixtureProtocol } from "./goals-fixtures";
import { gradeExtraction, gradeSeries, totals, type ExtractGrade, type SeriesGrade, type Totals } from "./goals-grade";

export interface DigestRun {
  slug: string;
  ok: boolean;
  error?: string;
  raw: SeriesGrade | null;
  guarded: SeriesGrade | null;
  demoted: number;
  droppedEvidence: number;
  usd: number;
  usage: NotesUsage | null;
  /** The model's answer (saved so a run can be regraded for free). */
  answer?: unknown;
}

export const truthHistory = (s: BuiltSeries): HistoryMeeting[] => s.protocols.map((p) => p.truth);

export async function runDigest(
  series: BuiltSeries,
  history: HistoryMeeting[],
  client: NotesClient,
  judged: Map<string, string | null> = new Map(),
): Promise<DigestRun> {
  const res = await digestGoals({ orgId: null, history, names: series.people }, { client, checkSpend: false });
  if (!res.ok) return { slug: series.slug, ok: false, error: res.error, raw: null, guarded: null, demoted: 0, droppedEvidence: 0, usd: res.usage?.usd ?? 0, usage: res.usage };
  const referenceDate = history.at(-1)!.date;
  const raw = finalizeGoals(res.answer, history, { referenceDate, names: series.people, guard: false });
  return {
    slug: series.slug,
    ok: true,
    raw: gradeSeries(series, raw.goals, judged),
    guarded: gradeSeries(series, res.goals, judged),
    demoted: res.demoted,
    droppedEvidence: res.droppedEvidence,
    usd: res.usage.usd,
    usage: res.usage,
    answer: res.answer,
  };
}

export interface ExtractRun {
  slug: string;
  index: number;
  ok: boolean;
  error?: string;
  grade: ExtractGrade | null;
  history: HistoryMeeting | null;
  usd: number;
  usage: NotesUsage | null;
}

/**
 * The Docs an admin would pick for the series: one per protocol, or (running Doc) ONE Doc with
 * every protocol, split like the import does. Each part names the protocol it should be.
 */
export function seriesDocs(series: BuiltSeries): { ok: true; parts: { protocol: FixtureProtocol; title: string; text: string }[] } | { ok: false; reason: string } {
  if (!series.runningDoc) return { ok: true, parts: series.protocols.map((p) => ({ protocol: p, title: p.title, text: p.text })) };
  const docTitle = series.protocols[0].title;
  const split = splitProtocols(docTitle, [{ title: "", text: series.protocols.map((p) => p.text).join("\n\n") }]);
  if (!split.ok) return { ok: false, reason: split.reason };
  if (split.sections.length !== series.protocols.length) return { ok: false, reason: `split into ${split.sections.length}, want ${series.protocols.length}` };
  return { ok: true, parts: split.sections.map((sec, k) => ({ protocol: series.protocols[k], title: sec.title, text: sec.text })) };
}

export async function runExtraction(
  series: BuiltSeries,
  p: FixtureProtocol,
  client: NotesClient,
  doc: { title: string; text: string } = { title: p.title, text: p.text },
): Promise<ExtractRun> {
  const res = await extractProtocol({ orgId: null, title: doc.title, text: doc.text, people: series.people }, { client, checkSpend: false });
  if (!res.ok) return { slug: series.slug, index: p.index, ok: false, error: res.error, grade: null, history: null, usd: res.usage?.usd ?? 0, usage: res.usage };
  // A protocol without a date would fall back to the file's date in the product; here the truth's.
  const meeting: HistoryMeeting = { date: res.protocol.date ?? p.date, source: "import", items: res.protocol.items };
  return {
    slug: series.slug,
    index: p.index,
    ok: true,
    grade: gradeExtraction(p.truth, res.protocol, series.allNames, series.routineTopics),
    history: meeting,
    usd: res.usage.usd,
    usage: res.usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Printing

const frac = (a: number, b: number) => `${a}/${b}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

function table(head: string[], body: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [fmt(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(fmt)].join("\n");
}

export function totalsTable(t: Totals): string {
  const body = t.classes.map((c) => [c.status, String(c.truth), frac(c.found, c.truth), frac(c.statusOk, c.truth), pct(c.statusOk, c.truth), pct(c.predictedOk, c.predicted)]);
  body.push(["ALL", String(t.goals), frac(t.found, t.goals), frac(t.statusOk, t.goals), pct(t.statusOk, t.goals), ""]);
  return [
    table(["status", "truth", "found", "status ok", "recall", "precision"], body),
    `last mentioned: exact ${frac(t.lastExact, t.found)}, within 7 days ${frac(t.lastWithin7, t.found)}; evidence dates real mentions ${frac(t.evidenceOk, t.evidenceTotal)} (${pct(t.evidenceOk, t.evidenceTotal)})`,
    `renamed goals under the newest name, once: ${frac(t.renamedOk, t.renamed)}; duplicates ${t.duplicates}; spurious goals ${t.spurious}`,
  ].join("\n");
}

export function digestDetails(grade: SeriesGrade): string {
  const lines = [`${grade.slug}:`];
  for (const r of grade.rows) {
    const got = r.goal ? `${r.goal.status.padEnd(8)} "${r.goal.title}" last ${r.goal.lastMentioned}` : "NOT FOUND";
    const mark = r.statusOk ? "ok  " : "MISS";
    lines.push(`  ${mark} ${r.truth.id.padEnd(22)} want ${r.truth.status.padEnd(8)} last ${r.truth.lastMentioned} | got ${got}${r.duplicates.length ? ` | DUP ${r.duplicates.join("; ")}` : ""}`);
  }
  for (const s of grade.spurious) lines.push(`  SPURIOUS "${s}"`);
  return lines.join("\n");
}

export function summarize(runs: DigestRun[]): { raw: Totals; guarded: Totals } {
  const ok = runs.filter((r) => r.ok);
  return { raw: totals(ok.map((r) => r.raw!)), guarded: totals(ok.map((r) => r.guarded!)) };
}

export function extractTable(runs: ExtractRun[]): string {
  const ok = runs.filter((r) => r.ok && r.grade);
  const sum = (f: (g: ExtractGrade) => number) => ok.reduce((n, r) => n + f(r.grade!), 0);
  const body = runs.map((r) =>
    r.grade
      ? [
          `${r.slug}#${r.index}`,
          r.grade.dateOk ? "ok" : "WRONG",
          frac(r.grade.decisions.ok, r.grade.decisions.total),
          frac(r.grade.tasks.ok, r.grade.tasks.total),
          frac(r.grade.reports.ok, r.grade.reports.total),
          String(r.grade.nameLeaks.length),
          `$${r.usd.toFixed(4)}`,
        ]
      : [`${r.slug}#${r.index}`, `FAILED ${r.error}`, "", "", "", "", `$${r.usd.toFixed(4)}`],
  );
  body.push([
    "ALL",
    frac(ok.filter((r) => r.grade!.dateOk).length, ok.length),
    frac(sum((g) => g.decisions.ok), sum((g) => g.decisions.total)),
    frac(sum((g) => g.tasks.ok), sum((g) => g.tasks.total)),
    frac(sum((g) => g.reports.ok), sum((g) => g.reports.total)),
    String(sum((g) => g.nameLeaks.length)),
    `$${runs.reduce((n, r) => n + r.usd, 0).toFixed(4)}`,
  ]);
  return table(["protocol", "date", "decisions", "tasks", "reports", "names", "$"], body);
}
