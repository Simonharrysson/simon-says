// Grader for the goals-from-history eval (todo #7). Deterministic: a proposed goal is matched to
// a ground-truth goal by the truth's keywords in its title, earlier names and why; then status,
// last-mentioned date, evidence dates, renames and duplicates are checked exactly. Only goals
// that match no truth goal (or match two equally) are left for the optional Claude judge
// (`judged` maps a proposed title to a truth id, or null = genuinely spurious).

import { GOAL_STATUSES, type DigestGoal, type GoalStatus, type HistoryItem, type HistoryMeeting } from "@/lib/history/types";
import type { BuiltSeries, TruthGoal } from "./goals-fixtures";

export interface GoalRow {
  truth: TruthGoal;
  /** The proposed goal matched to it (first one, by match strength). */
  goal: DigestGoal | null;
  statusOk: boolean;
  /** |proposed lastMentioned − truth lastMentioned| in days, null when not matched. */
  lastDays: number | null;
  /** Renamed goals: does the title use the newest name? null for others. */
  newName: boolean | null;
  /** Further proposed goals matched to the same truth goal (a renamed goal reported twice …). */
  duplicates: string[];
  /** Evidence lines whose date is a real mention of this goal / all its evidence lines. */
  evidenceOk: number;
  evidenceTotal: number;
}

export interface ClassScore {
  status: GoalStatus;
  truth: number;
  found: number;
  statusOk: number;
  predicted: number;
  predictedOk: number;
}

export interface SeriesGrade {
  slug: string;
  rows: GoalRow[];
  /** Proposed goals matching no truth goal (routine topics turned into goals, inventions). */
  spurious: string[];
  /** Proposed goals left for the judge (no or ambiguous keyword match), before judging. */
  unmatched: string[];
  classes: ClassScore[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFC");
const DAY = 24 * 3600 * 1000;
const days = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY);

/**
 * How strongly a proposed goal names a truth goal: 3 per distinct keyword in its title or earlier
 * names, 1 per keyword only in its why; 0 unless the match is specific: at least 2 distinct
 * keywords, or 1 keyword plus an evidence date that is a real mention of the truth goal. A
 * single broad word ("medlemmar") can then never pin a spurious goal on a truth goal.
 */
function matchScore(goal: DigestGoal, truth: TruthGoal): number {
  const text = norm([goal.title, ...goal.earlierNames, goal.why].join(" | "));
  const title = norm([goal.title, ...goal.earlierNames].join(" | "));
  const hits = truth.keywords.filter((k) => text.includes(k));
  const overlap = goal.evidence.some((e) => truth.mentions.includes(e.date));
  if (hits.length === 0 || (hits.length < 2 && !overlap)) return 0;
  return hits.reduce((n, k) => n + (title.includes(k) ? 3 : 1), 0) + (overlap ? 1 : 0);
}

/** Best truth goal for a proposed goal, or null when none is specific enough (or two tie). */
export function matchGoal(goal: DigestGoal, truths: TruthGoal[]): { truth: TruthGoal; score: number } | null {
  const scored = truths.map((t) => ({ truth: t, score: matchScore(goal, t) })).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return null;
  if (scored[1] && scored[1].score === scored[0].score) return null;
  return scored[0];
}

export function gradeSeries(series: BuiltSeries, goals: DigestGoal[], judged: Map<string, string | null> = new Map()): SeriesGrade {
  const byTruth = new Map<string, { goal: DigestGoal; score: number }[]>();
  const spurious: string[] = [];
  const unmatched: string[] = [];
  for (const g of goals) {
    let m = matchGoal(g, series.goals);
    if (!m) {
      unmatched.push(g.title);
      const id = judged.get(g.title);
      const t = id ? series.goals.find((x) => x.id === id) : undefined;
      if (!t) {
        spurious.push(g.title);
        continue;
      }
      m = { truth: t, score: 0.5 };
    }
    const list = byTruth.get(m.truth.id) ?? [];
    list.push({ goal: g, score: m.score });
    byTruth.set(m.truth.id, list);
  }
  const rows: GoalRow[] = series.goals.map((truth) => {
    const list = (byTruth.get(truth.id) ?? []).sort((a, b) => b.score - a.score);
    const goal = list[0]?.goal ?? null;
    const mentions = new Set(truth.mentions);
    return {
      truth,
      goal,
      statusOk: goal?.status === truth.status,
      lastDays: goal ? days(goal.lastMentioned, truth.lastMentioned) : null,
      newName: truth.newNameKeywords ? Boolean(goal && truth.newNameKeywords.some((k) => norm(goal.title).includes(k))) : null,
      duplicates: list.slice(1).map((x) => x.goal.title),
      evidenceOk: goal ? goal.evidence.filter((e) => mentions.has(e.date)).length : 0,
      evidenceTotal: goal ? goal.evidence.length : 0,
    };
  });
  const classes = GOAL_STATUSES.map((status) => {
    const t = rows.filter((r) => r.truth.status === status);
    const predictedRows = goals.filter((g) => g.status === status);
    const okPredicted = rows.filter((r) => r.goal?.status === status && r.truth.status === status).length;
    return {
      status,
      truth: t.length,
      found: t.filter((r) => r.goal).length,
      statusOk: t.filter((r) => r.statusOk).length,
      predicted: predictedRows.length,
      predictedOk: okPredicted,
    };
  });
  return { slug: series.slug, rows, spurious, unmatched, classes };
}

export interface Totals {
  goals: number;
  found: number;
  statusOk: number;
  lastExact: number;
  lastWithin7: number;
  evidenceOk: number;
  evidenceTotal: number;
  renamed: number;
  renamedOk: number;
  duplicates: number;
  spurious: number;
  classes: ClassScore[];
}

export function totals(grades: SeriesGrade[]): Totals {
  const rows = grades.flatMap((g) => g.rows);
  const renamed = rows.filter((r) => r.newName !== null);
  return {
    goals: rows.length,
    found: rows.filter((r) => r.goal).length,
    statusOk: rows.filter((r) => r.statusOk).length,
    lastExact: rows.filter((r) => r.lastDays === 0).length,
    lastWithin7: rows.filter((r) => r.lastDays !== null && r.lastDays <= 7).length,
    evidenceOk: rows.reduce((n, r) => n + r.evidenceOk, 0),
    evidenceTotal: rows.reduce((n, r) => n + r.evidenceTotal, 0),
    renamed: renamed.length,
    renamedOk: renamed.filter((r) => r.newName && r.duplicates.length === 0).length,
    duplicates: rows.reduce((n, r) => n + r.duplicates.length, 0),
    spurious: grades.reduce((n, g) => n + g.spurious.length, 0),
    classes: GOAL_STATUSES.map((status) => {
      const cs = grades.map((g) => g.classes.find((c) => c.status === status)!);
      return {
        status,
        truth: cs.reduce((n, c) => n + c.truth, 0),
        found: cs.reduce((n, c) => n + c.found, 0),
        statusOk: cs.reduce((n, c) => n + c.statusOk, 0),
        predicted: cs.reduce((n, c) => n + c.predicted, 0),
        predictedOk: cs.reduce((n, c) => n + c.predictedOk, 0),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Extraction grading (one protocol): date exact, recall of the truth's decisions / tasks /
// reports by key words, done flags, owners as roles, and no name of anyone in the series.

export interface ExtractGrade {
  dateOk: boolean;
  decisions: { ok: number; total: number };
  tasks: { ok: number; total: number };
  reports: { ok: number; total: number };
  doneOk: number;
  ownerOk: number;
  /** Stored texts that still hold a name of someone in the series. */
  nameLeaks: string[];
  missing: string[];
  /** After the Claude judge (paid runs, --judge): the lines still missing; the rest were there in other words or another language. */
  judgedMissing?: string[];
}

const STOP = new Set(["att", "och", "för", "till", "med", "som", "den", "det", "har", "på", "av", "en", "ett", "vi", "är", "nu", "om", "i", "de", "från"]);
const keyWords = (s: string) =>
  norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP.has(w));

/** True when `got` holds at least 60 % of the long words of `want`. */
export function sameLine(want: string, got: string): boolean {
  const w = keyWords(want);
  if (!w.length) return true;
  const g = norm(got);
  return w.filter((x) => g.includes(x.slice(0, Math.max(4, x.length - 2)))).length / w.length >= 0.6;
}

export function gradeExtraction(
  truth: HistoryMeeting,
  got: { date: string | null; items: HistoryItem[] },
  allNames: string[],
  routineTopics: string[] = [],
): ExtractGrade {
  const missing: string[] = [];
  // Routine lines (the treasurer's report …) say nothing about goals: an extractor may skip them.
  truth = { ...truth, items: truth.items.filter((i) => !(i.topic && routineTopics.includes(i.topic))) };
  const recall = (kind: HistoryItem["kind"], pool: HistoryItem["kind"][]) => {
    const want = truth.items.filter((i) => i.kind === kind);
    const have = got.items.filter((i) => pool.includes(i.kind));
    let ok = 0;
    for (const w of want) {
      if (have.some((h) => sameLine(w.text, h.text))) ok++;
      else missing.push(`${kind}: ${w.text}`);
    }
    return { ok, total: want.length };
  };
  // A decision found as a report (or the other way) still carries the signal: count it.
  const decisions = recall("decision", ["decision", "report"]);
  const reports = recall("report", ["report", "decision"]);
  const tasks = recall("task", ["task"]);
  let doneOk = 0;
  let ownerOk = 0;
  for (const w of truth.items.filter((i) => i.kind === "task")) {
    const h = got.items.find((i) => i.kind === "task" && sameLine(w.text, i.text));
    if (h && h.done === w.done) doneOk++;
    if (h && w.owner && h.owner && norm(h.owner).includes(norm(w.owner).slice(0, 5))) ownerOk++;
  }
  const parts = [...new Set(allNames.flatMap((n) => [n, ...n.split(" ")]))].filter((p) => p.length >= 3);
  const nameLeaks = got.items
    .flatMap((i) => [i.text, i.topic ?? "", i.owner ?? ""])
    .filter((t) => parts.some((p) => new RegExp(`(?<![\\p{L}])${p}(?![\\p{L}])`, "iu").test(t)));
  return { dateOk: got.date === truth.date, decisions, tasks, reports, doneOk, ownerOk, nameLeaks, missing };
}
