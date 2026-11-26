import { describe, expect, it } from "vitest";
import { allSeries, monthsBetween, FIXTURE_STALE_MONTHS } from "./goals-fixtures";
import { flawedDigest, perfectDigest, perfectExtraction, scriptedClient } from "./goals-scripted";
import { runDigest, runExtraction, summarize, truthHistory } from "./goals-eval";
import { gradeExtraction, matchGoal } from "./goals-grade";

// The goals eval's free dry run (todo #7), as CI runs it: fixtures are sound, a perfect scripted
// answer scores 100 %, and every planted fault in the flawed answer is caught. Fictional data.

const FREE = { input_tokens: 0, output_tokens: 0 };
const series = allSeries();

describe("goals fixtures", () => {
  it("4 föreningar, 15–30 protocols each, every status class and every hard case present", () => {
    expect(series).toHaveLength(4);
    for (const s of series) {
      expect(s.protocols.length).toBeGreaterThanOrEqual(15);
      expect(s.protocols.length).toBeLessThanOrEqual(30);
      expect(s.protocols.map((p) => p.date)).toEqual([...s.protocols.map((p) => p.date)].sort());
    }
    const goals = series.flatMap((s) => s.goals);
    for (const status of ["current", "achieved", "dropped", "stale"]) expect(goals.some((g) => g.status === status)).toBe(true);
    for (const tag of ["renamed", "revived", "report-only", "late-start", "boundary", "implicit", "dropped-then-revived", "paused", "tasks-only", "object-lives-on"]) expect(goals.some((g) => g.tags.includes(tag as never))).toBe(true);
  });

  it("stale and current agree with the 3-month rule; revived goals have a gap of more than 3 months", () => {
    for (const s of series) {
      for (const g of s.goals) {
        const quiet = monthsBetween(g.lastMentioned, s.lastDate) > FIXTURE_STALE_MONTHS;
        if (g.status === "stale") expect(quiet).toBe(true);
        if (g.status === "current") expect(quiet).toBe(false);
        if (g.tags.includes("revived")) {
          const gaps = g.mentions.slice(1).map((d, i) => monthsBetween(g.mentions[i], d));
          expect(Math.max(...gaps)).toBeGreaterThan(FIXTURE_STALE_MONTHS);
        }
      }
    }
  });

  it("protocol text names people (also former board members, not in people); the truth never does", () => {
    for (const s of series) {
      const former = s.allNames.filter((n) => !s.people.includes(n));
      expect(former.length).toBeGreaterThan(0);
      const text = s.protocols.map((p) => p.text).join("\n");
      expect(former.some((n) => text.includes(n.split(" ")[0]))).toBe(true);
      const truth = s.protocols.flatMap((p) => p.truth.items.map((i) => `${i.text} ${i.owner ?? ""}`)).join("\n");
      for (const n of s.allNames) expect(truth).not.toContain(n.split(" ")[0]);
    }
  });

  it("Simon Says' own meetings (ownFrom) hold no status reports, as ownHistory never makes any", () => {
    for (const s of series) {
      for (const p of s.protocols.filter((x) => x.truth.source === "simonsays")) expect(p.truth.items.some((i) => i.kind === "report")).toBe(false);
    }
    expect(series.some((s) => s.protocols.some((p) => p.truth.source === "simonsays"))).toBe(true);
  });

  it("report-only achievements have no decision in the achieving protocol", () => {
    for (const s of series) {
      for (const g of s.goals.filter((x) => x.tags.includes("report-only"))) {
        const p = s.protocols.find((x) => x.date === g.lastMentioned)!;
        const lines = p.truth.items.filter((i) => g.keywords.some((k) => `${i.text} ${i.topic}`.toLowerCase().includes(k)));
        expect(lines.some((i) => i.kind === "report")).toBe(true);
        expect(lines.some((i) => i.kind === "decision")).toBe(false);
      }
    }
  });
});

describe("goals eval dry run", () => {
  it("a perfect scripted digest scores 100 % on every measure", async () => {
    const runs = [];
    for (const s of series) runs.push(await runDigest(s, truthHistory(s), scriptedClient([perfectDigest(s)], FREE)));
    const { raw, guarded } = summarize(runs);
    for (const t of [raw, guarded]) {
      expect(t.statusOk).toBe(t.goals);
      expect(t.lastExact).toBe(t.goals);
      expect(t.evidenceOk).toBe(t.evidenceTotal);
      expect(t.renamedOk).toBe(t.renamed);
      expect(t.duplicates + t.spurious).toBe(0);
    }
  });

  it("the flawed scripted digest: every planted fault is caught, and the code guard fixes only the stale slip", async () => {
    const runs = [];
    for (const s of series) runs.push(await runDigest(s, truthHistory(s), scriptedClient([flawedDigest(s)], FREE)));
    const { raw, guarded } = summarize(runs);
    const cls = (t: typeof raw, s: string) => t.classes.find((c) => c.status === s)!;
    const n = series.length;
    const withTag = (tag: string) => series.filter((x) => x.goals.some((g) => g.tags.includes(tag as never))).length;
    // The first dropped goal left out in each series.
    expect(raw.found).toBe(raw.goals - n);
    expect(cls(raw, "dropped").found).toBe(cls(raw, "dropped").truth - n);
    // The first stale goal called current: wrong raw, fixed by the guard.
    expect(cls(raw, "stale").statusOk).toBe(cls(raw, "stale").truth - n);
    expect(cls(guarded, "stale").statusOk).toBe(cls(guarded, "stale").truth);
    // Report-only achievement called current: wrong either way (guarded it is stale, still not achieved).
    expect(cls(guarded, "achieved").statusOk).toBe(cls(guarded, "achieved").truth - withTag("report-only"));
    // Renamed goal reported twice, Ekonomi as a goal, invented evidence date dropped.
    expect(raw.duplicates).toBe(withTag("renamed"));
    expect(raw.renamedOk).toBe(0);
    expect(raw.spurious).toBe(n);
    expect(runs.reduce((k, r) => k + r.droppedEvidence, 0)).toBe(n);
    expect(runs.reduce((n, r) => n + r.demoted, 0)).toBeGreaterThanOrEqual(n);
  });

  it("scripted extraction of every protocol: dates right, all lines recalled, no name stored", async () => {
    for (const s of series) {
      for (const p of s.protocols) {
        const r = await runExtraction(s, p, scriptedClient([perfectExtraction(p, s.allNames)], FREE));
        expect(r.ok).toBe(true);
        expect(r.grade!.dateOk).toBe(true);
        expect(r.grade!.missing).toEqual([]);
        expect(r.grade!.nameLeaks).toEqual([]);
      }
    }
  });

  it("the extraction grader catches a name, a wrong date and a missing line", () => {
    const s = series[0];
    const p = s.protocols[9];
    const items = p.truth.items.filter((i) => i.kind !== "report").map((i) => (i.kind === "decision" ? { ...i, text: `${i.text} enligt Hedvig` } : i));
    const g = gradeExtraction(p.truth, { date: "2025-01-01", items }, s.allNames);
    expect(g.dateOk).toBe(false);
    expect(g.nameLeaks.length).toBeGreaterThan(0);
    expect(g.missing.some((m) => m.startsWith("report:"))).toBe(true);
  });

  it("matching: a goal named only by its why still matches; a tie between two goals stays unmatched", () => {
    const s = series[0];
    const goal = { title: "Något helt annat", status: "current" as const, why: "Spelkaféet på biblioteket rullar.", earlierNames: [], firstMentioned: "", lastMentioned: "", evidence: [] };
    expect(matchGoal(goal, s.goals)?.truth.id).toBe("rutan-spelkafe");
    expect(matchGoal({ ...goal, why: "" }, s.goals)).toBeNull();
  });
});
