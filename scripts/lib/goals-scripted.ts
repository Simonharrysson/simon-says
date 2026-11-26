// Scripted Claude answers for the goals eval's free dry run (CI): a perfect digest built from
// the ground truth, a flawed one with the mistakes the eval must catch, and a fake client that
// returns them. A dry run that could only score 100 % would prove nothing, so the flawed answer
// is graded too and its expected faults are asserted (scripts/lib/goals-eval.test.ts).

import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DigestAnswer } from "@/lib/history/digest-input";
import type { ExtractAnswer } from "@/lib/history/extract-prompt";
import type { NotesClient } from "@/lib/notes/engine";
import type { BuiltSeries, FixtureProtocol, TruthGoal } from "./goals-fixtures";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function titleOf(g: TruthGoal): string {
  const k = g.newNameKeywords?.[0] ?? g.keywords[0];
  return capital(`${k} (${g.id.split("-")[1]})`);
}

function evidenceOf(series: BuiltSeries, g: TruthGoal) {
  return g.mentions.slice(-4).map((date) => {
    const p = series.protocols.find((x) => x.date === date)!;
    const line = p.truth.items.find((i) => i.kind !== "topic" && g.keywords.some((k) => (i.text + (i.topic ?? "")).toLowerCase().includes(k)));
    return { date, text: line?.text ?? "nämndes" };
  });
}

/** What a perfect digest would answer. */
export function perfectDigest(series: BuiltSeries): DigestAnswer {
  return {
    goals: series.goals.map((g) => ({
      title: titleOf(g),
      status: g.status,
      why: `Senast uppe ${g.lastMentioned}.`,
      earlier_names: g.tags.includes("renamed") ? [capital(g.keywords[1] ?? g.keywords[0])] : [],
      first_mentioned: g.firstMentioned,
      last_mentioned: g.lastMentioned,
      evidence: evidenceOf(series, g),
    })),
    explanation: "Skriptat svar.",
  };
}

/**
 * The perfect answer with typical mistakes: the stale goal called current (the code guard must
 * catch it), a report-only achievement called current, a renamed goal reported twice (old name
 * as its own stale goal), the routine Ekonomi item as a goal, an evidence date that is no meeting,
 * and the first dropped goal left out.
 */
export function flawedDigest(series: BuiltSeries): DigestAnswer {
  const answer = perfectDigest(series);
  const byId = (id: string) => answer.goals[series.goals.findIndex((g) => g.id === id)];
  const staleGoal = series.goals.find((g) => g.status === "stale");
  if (staleGoal) byId(staleGoal.id).status = "current";
  const reportOnly = series.goals.find((g) => g.tags.includes("report-only"));
  if (reportOnly) byId(reportOnly.id).status = "current";
  const renamed = series.goals.find((g) => g.tags.includes("renamed"));
  if (renamed) {
    const old = renamed.keywords.find((k) => !renamed.newNameKeywords?.some((n) => k.includes(n))) ?? renamed.keywords[0];
    answer.goals.push({
      title: capital(`${old} (gamla namnet)`),
      status: "stale",
      why: "Gamla namnet.",
      earlier_names: [],
      first_mentioned: renamed.firstMentioned,
      last_mentioned: renamed.firstMentioned,
      evidence: [{ date: renamed.firstMentioned, text: "nämndes" }],
    });
  }
  const first = answer.goals[0];
  first.evidence = [...first.evidence, { date: "2024-01-01", text: "påhittat datum" }];
  answer.goals.push({
    title: "Ekonomin i balans",
    status: "current",
    why: "Ekonomi på varje möte.",
    earlier_names: [],
    first_mentioned: series.protocols[0].date,
    last_mentioned: series.lastDate,
    evidence: [{ date: series.lastDate, text: "Kassan redovisades" }],
  });
  const droppedIdx = series.goals.findIndex((g) => g.status === "dropped");
  if (droppedIdx >= 0) answer.goals.splice(droppedIdx, 1);
  return answer;
}

/** A perfect extraction answer for one protocol (the truth, plus the names it holds). */
export function perfectExtraction(p: FixtureProtocol, names: string[]): ExtractAnswer {
  const of = (k: string) => p.truth.items.filter((i) => i.kind === k);
  return {
    date: p.date,
    topics: of("topic").map((i) => i.text),
    decisions: of("decision").map((i) => ({ text: i.text, topic: i.topic })),
    tasks: of("task").map((i) => ({ text: i.text, owner: i.owner, done: i.done, topic: i.topic })),
    reports: of("report").map((i) => ({ text: i.text, topic: i.topic })),
    names,
  };
}

/** A fake client returning `answers` in order (a fixed usage per call). */
export function scriptedClient(answers: unknown[], usage = { input_tokens: 3000, output_tokens: 1500 }): NotesClient & { calls: number } {
  const c = {
    calls: 0,
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            const a = answers[Math.min(c.calls, answers.length - 1)];
            c.calls++;
            return {
              id: `msg_scripted_${c.calls}`,
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "text", text: JSON.stringify(a) }],
              stop_reason: "end_turn",
              usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            } as unknown as BetaMessage;
          },
        }),
      },
    },
  };
  return c;
}
