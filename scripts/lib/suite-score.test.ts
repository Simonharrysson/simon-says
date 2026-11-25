import { describe, expect, it } from "vitest";
import type { Score } from "./notes-score";
import { evalRunPasses, FEATURES, formatScorecard, paidFixtures, scorecard, suiteFiles, withPaid, type VitestReport } from "./suite-score";

const ROOT = "/repo";
const t = (ancestorTitles: string[], title: string, status = "passed") => ({ ancestorTitles, title, status });
const report: VitestReport = {
  testResults: [
    {
      name: "/repo/tests/suite/formats.test.ts",
      status: "passed",
      assertionResults: [t(["feature: formats (document formats)"], "a"), t(["feature: formats (runTick on the local stack)"], "db", "skipped")],
    },
    {
      name: "/repo/tests/suite/transcription.test.ts",
      status: "failed",
      assertionResults: [t(["feature: transcription (x)"], "BUG: roles"), t(["feature: transcription (x)"], "b", "failed")],
    },
    // A tagged existing file: every test counts for its features.
    { name: "/repo/lib/agenda/followup.test.ts", status: "passed", assertionResults: [t(["openTasks"], "c"), t(["carryPlan"], "d")] },
    // A suite file that failed to load: charged to the feature its name says.
    { name: "/repo/tests/suite/voices.test.ts", status: "failed", message: "SyntaxError: nope\n at x", assertionResults: [] },
  ],
};

const score = (over: Partial<Score> = {}): Score => ({
  found: 2,
  total: 2,
  recall: [],
  mustNot: [],
  mustNotPersistent: [],
  mustNotLive: [],
  placement: { ok: 10, total: 10 },
  roles: { ok: 1, total: 1 },
  followup: { ok: 0, total: 0 },
  checkinLeaks: [],
  ...over,
});

describe("suite scorecard", () => {
  it("groups by the feature: tag, tagged files count whole, a load failure fails its feature, a feature with no test run fails", () => {
    const rows = scorecard(report, ROOT);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(rows.map((r) => r.key)).toEqual(FEATURES.map((f) => f.key));
    expect(by.formats).toMatchObject({ passed: 1, failed: 0, skipped: 1, pass: true, files: ["tests/suite/formats.test.ts"] });
    expect(by.transcription).toMatchObject({ passed: 1, failed: 1, pass: false, bugs: ["BUG: roles"] });
    expect(by.chain).toMatchObject({ passed: 2, pass: true, files: ["lib/agenda/followup.test.ts"] });
    expect(by.voices).toMatchObject({ failed: 1, pass: false, failures: ["tests/suite/voices.test.ts: SyntaxError: nope"] });
    expect(by.safety).toMatchObject({ passed: 0, pass: false });
  });

  it("paid: notes-eval's bars (churn ≤ 15 %, ≤ $1.50/h, every score bar); a missing fixture fails; voices has none", () => {
    expect(evalRunPasses({ name: "a", medianChurn: 0.1, perHour: 1.2, score: score() })).toBe(true);
    expect(evalRunPasses({ name: "a", medianChurn: null, perHour: 1.2, score: score() })).toBe(false);
    expect(evalRunPasses({ name: "a", medianChurn: 0, perHour: 1.51, score: score() })).toBe(false);
    expect(evalRunPasses({ name: "a", medianChurn: 0, perHour: 1, score: score({ placement: { ok: 8, total: 10 } }) })).toBe(false);
    const rows = withPaid(scorecard(report, ROOT), [
      { name: "veckomote-a", medianChurn: 0, perHour: 1, score: score() },
      { name: "styrelse-ekdala", medianChurn: 0, perHour: 1, score: score() },
      { name: "styrelse-ekdala", medianChurn: 0, perHour: 1, score: score({ found: 1 }) },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.formats.paid?.map((p) => [p.fixture, p.pass])).toEqual([
      ["veckomote-a", true],
      ["styrelse-ekdala", false],
    ]);
    expect(by.formats.paid?.[1].detail).toContain("recall 1/2");
    expect(by.transcription.paid).toEqual([{ fixture: "owner-styles", pass: false, detail: "not run" }]);
    expect(by.voices.paid).toBeNull();
    expect(formatScorecard(rows)).toContain("paid formats: styrelse-ekdala FAIL");
  });

  it("runs tests/suite and every tagged file; the paid fixtures exist", async () => {
    const { existsSync } = await import("node:fs");
    expect(suiteFiles()[0]).toBe("tests/suite");
    for (const f of suiteFiles()) expect(existsSync(f), f).toBe(true);
    for (const f of paidFixtures()) expect(existsSync(`fixtures/notes/${f}.jsonl`), f).toBe(true);
  });
});
