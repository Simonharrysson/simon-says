import { z } from "zod";
import type { NotesClient } from "@/lib/notes/engine";
import { oneShot, type OneShotResult } from "@/lib/notes/oneshot";
import type { PrivatLocale } from "./format";

// The one Claude call after a Privat recording (spec: "one Claude call after the final pass over
// the stored note items + transcript, with the context's open tasks + recent decisions as input;
// structured output; spend gate"). Through oneShot: model, fallbacks, KILL_SWITCH and the daily
// dollar cap, usage booked on the space. The answer's open-task verdicts become "Sedan sist"
// (since-last.ts). Never logs the prompt or the answer.

export const PRIVAT_SUMMARY_SYSTEM_PROMPT = `You write the summary a person gets by e-mail after recording something on their own: a meeting, a lecture, a call, a group-work session. You get the context the recording belongs to (a course, a project, a customer, "Övrigt"), the notes that were kept live during the recording (decisions, tasks, the current topic), the transcript (from automatic speech recognition, may be garbled, speaker labels like S1-speaker_0 or names), the context's tasks that were still open before this recording (each with an id like t3), and the decisions from the last few recordings in the same context.

Answer with JSON only, in the requested language:
- summary: 2–5 plain sentences on what this recording was about and what came out of it. No greeting, no "In this meeting".
- decisions: what was decided in THIS recording, one short sentence each. Empty when nothing was decided. Never repeat an earlier decision unless it was changed.
- facts: key facts worth remembering later (dates, deadlines, numbers, names of things, requirements, exam info). Short. At most 8.
- tasks: NEW things someone will do, from this recording. "text" starts with a verb. "owner": the person's name when someone other than the user takes it on; null when it is the user's own task or unclear. "due": the deadline as said ("fredag", "15 dec"), else null. Do NOT list a task that is already among the open tasks you were given (judge it under "previous" instead).
- questions: open questions that were raised and not answered. At most 5.
- people: names of people who took part or were talked about (as said; no speaker labels). At most 8.
- topics: 1–5 short topic labels (1–3 words) for what was discussed, reusable across recordings ("tentamen", "budget", "labb 2").
- previous: one entry per open task you were given: "done" when the recording says it is done, "open" when it was discussed and is still to do, "not_mentioned" when the recording does not touch it. Use the given ids; never invent ids.

Be faithful to the recording: never invent decisions, tasks or facts. Keep names as spoken. When the recording is too short or unclear to say anything, write that in one sentence as the summary and leave the lists empty.`;

export const PRIVAT_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions", "facts", "tasks", "questions", "people", "topics", "previous"],
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    facts: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "owner", "due"],
        properties: { text: { type: "string" }, owner: { anyOf: [{ type: "string" }, { type: "null" }] }, due: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
    },
    questions: { type: "array", items: { type: "string" } },
    people: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    previous: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: { id: { type: "string" }, status: { type: "string", enum: ["done", "open", "not_mentioned"] } },
      },
    },
  },
} as const;

export const TaskStatusSchema = z.enum(["done", "open", "not_mentioned"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const PrivatSummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  facts: z.array(z.string()),
  tasks: z.array(z.object({ text: z.string(), owner: z.string().nullable(), due: z.string().nullable() })),
  questions: z.array(z.string()),
  people: z.array(z.string()),
  topics: z.array(z.string()),
  previous: z.array(z.object({ id: z.string(), status: TaskStatusSchema })),
});
export type PrivatSummaryAnswer = z.infer<typeof PrivatSummarySchema>;

export interface OpenTaskInput {
  /** The short id Claude sees ("t1"). */
  key: string;
  text: string;
  owner: string | null;
  /** When the task came up (ISO). */
  since: string;
}

export interface PrivatSummaryInput {
  locale: PrivatLocale;
  contextName: string;
  /** The user's own name (Google), when known: "owner null" means theirs. */
  userName: string | null;
  startedAt: string;
  /** Live notes as lines ("Beslut: …", "Uppgift (Anna): …"). */
  notes: string[];
  /** "[00:01:05] Anna: …" lines. */
  transcript: string[];
  openTasks: OpenTaskInput[];
  recentDecisions: string[];
}

/** Characters of transcript sent at most (≈ 30k tokens): the end is kept, the start cut. */
export const TRANSCRIPT_MAX_CHARS = 120_000;
const MAX_ITEMS = 40;

/** One line of text: no control characters, no newlines. */
const line = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The transcript lines that fit, newest kept (what was said last matters most for tasks). */
export function fitTranscript(lines: string[], max = TRANSCRIPT_MAX_CHARS): { lines: string[]; cut: boolean } {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > max) return { lines: kept.reverse(), cut: true };
    kept.push(lines[i]);
  }
  return { lines: kept.reverse(), cut: false };
}

export function buildPrivatSummaryUserText(input: PrivatSummaryInput): string {
  const t = fitTranscript(input.transcript.map(line).filter(Boolean));
  const out = [
    `Language for every text you write: ${input.locale === "en" ? "English" : "Swedish (svenska)"}`,
    `Context: ${line(input.contextName)}`,
    `Recorded: ${input.startedAt}`,
    `The user (who recorded): ${input.userName ? line(input.userName) : "unknown name"}`,
    "",
    "<open_tasks>",
    ...(input.openTasks.length
      ? input.openTasks.slice(0, MAX_ITEMS).map((o) => `[${o.key}] ${line(o.text)}${o.owner ? ` (owner: ${line(o.owner)})` : ""} (since ${o.since.slice(0, 10)})`)
      : ["(none)"]),
    "</open_tasks>",
    "",
    "<recent_decisions>",
    ...(input.recentDecisions.length ? input.recentDecisions.slice(0, MAX_ITEMS).map((d) => `- ${line(d)}`) : ["(none)"]),
    "</recent_decisions>",
    "",
    "<live_notes>",
    ...(input.notes.length ? input.notes.map(line) : ["(none)"]),
    "</live_notes>",
    "",
    `<transcript${t.cut ? ' note="the beginning was cut; this is the end"' : ""}>`,
    ...(t.lines.length ? t.lines : ["(nothing was transcribed)"]),
    "</transcript>",
  ];
  return out.join("\n");
}

/** Trimmed, non-empty, deduplicated, capped: what is stored and mailed. */
export function cleanAnswer(a: PrivatSummaryAnswer): PrivatSummaryAnswer {
  const list = (xs: string[], max: number) => [...new Set(xs.map(line).filter(Boolean))].slice(0, max);
  const opt = (s: string | null) => (s && line(s) ? line(s).slice(0, 100) : null);
  return {
    summary: line(a.summary).slice(0, 2000),
    decisions: list(a.decisions, 20),
    facts: list(a.facts, 12),
    tasks: a.tasks
      .map((x) => ({ text: line(x.text).slice(0, 500), owner: opt(x.owner), due: opt(x.due) }))
      .filter((x) => x.text)
      .slice(0, 20),
    questions: list(a.questions, 8),
    people: list(a.people, 12).map((p) => p.slice(0, 100)),
    topics: list(a.topics, 6).map((p) => p.slice(0, 60)),
    previous: a.previous,
  };
}

export type SummarizeFn = (input: PrivatSummaryInput, opts: { orgId: string; timeoutMs?: number }) => Promise<OneShotResult<PrivatSummaryAnswer>>;

export function summarizePrivat(client?: NotesClient): SummarizeFn {
  return async (input, opts) => {
    const res = await oneShot({
      label: "privat summary",
      system: PRIVAT_SUMMARY_SYSTEM_PROMPT,
      user: buildPrivatSummaryUserText(input),
      jsonSchema: PRIVAT_SUMMARY_JSON_SCHEMA,
      schema: PrivatSummarySchema,
      maxTokens: 4000,
      orgId: opts.orgId,
      client,
      timeoutMs: opts.timeoutMs,
    });
    return res.ok ? { ...res, value: cleanAnswer(res.value) } : res;
  };
}
