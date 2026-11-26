import { z } from "zod";
import { isDecision, isTask } from "@/lib/meetings/summary";
import { scrubNames } from "@/lib/dashboard/names";
import { countedMeetings, itemLabel, underCheckin, type DashInput } from "@/lib/dashboard/overview";
import { GOAL_STATUSES, type DigestGoal, type GoalStatus, type HistoryItem, type HistoryMeeting } from "./types";

// Step 2 of goals-from-history (todo #7): the WHOLE history in one long-context call, no
// chunking, no retrieval. Pure: the history builder, the prompt text, the schema and the
// code-side checks on the answer (digest.ts makes the call).
//
// Temporal rules, explicit in the prompt AND enforced here:
// - the reference date is the latest meeting in the history (an old, finished year must not make
//   every goal "stale" just because the import happens later);
// - newer meetings override older ones;
// - a goal not mentioned in the STALE_MONTHS before the reference date is stale, not current;
// - evidence and "last mentioned" must be dates of meetings in the history.

export const STALE_MONTHS = 3;
const MAX_EVIDENCE = 6;
const MAX_TITLE = 80;
const MAX_WHY = 240;
const MAX_EVIDENCE_TEXT = 200;
/** Above this the history is too long for one call (≈ 300k tokens): the route refuses. */
export const MAX_HISTORY_CHARS = 900_000;

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * Simon Says' own ended meetings as history: decisions, tasks written in that meeting, carried
 * tasks closed in it (as done) and the agenda labels. No status "reports": Simon Says' notes have
 * none, so in the förening's own meetings progress shows only as decisions and tasks. Same privacy rules as the goals proposal: no Testmöte,
 * nothing under a Må-runda item, people's names → "en person", no owners' names (an owner that is
 * a person becomes null).
 */
export function ownHistory(orgId: string, input: DashInput): HistoryMeeting[] {
  const names = input.people.map((p) => p.name);
  const text = (s: string) => cut(collapse(scrubNames(s, names)), MAX_EVIDENCE_TEXT);
  const meetings = countedMeetings(orgId, input.meetings);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const items = new Map<string, HistoryItem[]>();
  for (const m of meetings) {
    const labels = Object.entries(m.agenda_labels ?? {})
      .filter(([k]) => m.agenda_roles?.[k] !== "checkin")
      .map(([, v]) => v);
    items.set(
      m.id,
      labels.map((l) => ({ kind: "topic", text: text(l), topic: null, owner: null, done: null })),
    );
  }
  const rows = [...input.items].sort((a, b) => a.position - b.position);
  for (const r of rows) {
    const m = byId.get(r.meeting_id);
    if (!m || underCheckin(m, r)) continue;
    const label = itemLabel(m, r.anchor);
    const topic = label ? text(label) : null;
    if (isDecision(r)) items.get(m.id)!.push({ kind: "decision", text: text(r.text), topic, owner: null, done: null });
    else if (isTask(r) && (!r.carried_from_id || r.done)) {
      // Written in this meeting, or carried here and closed here (shown done in the meeting that closed it).
      const owner = r.owner_person_id || !r.owner ? null : text(r.owner);
      items.get(m.id)!.push({ kind: "task", text: text(r.text), topic, owner: owner === "en person" ? null : owner, done: Boolean(r.done) });
    }
  }
  return meetings.map((m) => ({ date: m.started_at.slice(0, 10), source: "simonsays" as const, items: items.get(m.id)! }));
}

/** Imported and own meetings, oldest first (same date: imported first). Empty meetings dropped. */
export function mergeHistory(...parts: HistoryMeeting[][]): HistoryMeeting[] {
  return parts
    .flat()
    .filter((m) => m.items.some((i) => i.kind !== "topic"))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.source === b.source ? 0 : a.source === "import" ? -1 : 1));
}

const tag = (i: HistoryItem) => (i.topic ? `[${i.topic}] ` : "");

/** The history as Claude reads it: one block per meeting, oldest first. */
export function buildDigestUserText(history: HistoryMeeting[], opts: { referenceDate: string; staleMonths?: number }): string {
  const stale = opts.staleMonths ?? STALE_MONTHS;
  const blocks = history.map((m, n) => {
    const of = (k: HistoryItem["kind"]) => m.items.filter((i) => i.kind === k);
    const lines = [`### Möte ${n + 1} · ${m.date} · ${m.source === "import" ? "gammalt protokoll" : "Simon Says"}`];
    const topics = of("topic").map((i) => i.text);
    if (topics.length) lines.push(`Punkter: ${topics.join("; ")}`);
    const section = (title: string, rows: HistoryItem[], fmt: (i: HistoryItem) => string) => {
      if (rows.length) lines.push(`${title}:`, ...rows.map((i) => `- ${fmt(i)}`));
    };
    section("Beslut", of("decision"), (i) => `${tag(i)}${i.text}`);
    section("Uppgifter", of("task"), (i) => `${tag(i)}${i.owner ? `(${i.owner}) ` : ""}${i.text}${i.done === true ? " [klar]" : i.done === false ? " [ej klar]" : ""}`);
    section("Läge", of("report"), (i) => `${tag(i)}${i.text}`);
    return lines.join("\n");
  });
  const body = blocks.join("\n\n").replace(/<\/?historik\b/gi, (x) => x.replace("<", "‹"));
  return [
    `<historik möten="${history.length}" från="${history[0]?.date ?? ""}" till="${opts.referenceDate}">`,
    body,
    "</historik>",
    "",
    `Referensdatum (senaste mötet): ${opts.referenceDate}. Ett mål som inte nämnts på något möte de ${stale} månaderna före referensdatumet är "stale", inte "current".`,
    "Gå igenom hela historiken i tidsordning och returnera målen enligt reglerna.",
  ].join("\n");
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };

export const DIGEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goals", "explanation"],
  properties: {
    goals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "status", "why", "earlier_names", "first_mentioned", "last_mentioned", "evidence"],
        properties: {
          title: str,
          status: { type: "string", enum: [...GOAL_STATUSES] },
          why: str,
          earlier_names: { type: "array", items: str },
          first_mentioned: nullable(str),
          last_mentioned: nullable(str),
          evidence: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["date", "text"], properties: { date: str, text: str } },
          },
        },
      },
    },
    explanation: str,
  },
} as const;

export const DigestAnswerSchema = z.object({
  goals: z.array(
    z.object({
      title: z.string(),
      status: z.enum(GOAL_STATUSES),
      why: z.string(),
      earlier_names: z.array(z.string()),
      first_mentioned: z.string().nullable(),
      last_mentioned: z.string().nullable(),
      evidence: z.array(z.object({ date: z.string(), text: z.string() })),
    }),
  ),
  explanation: z.string(),
});
export type DigestAnswer = z.infer<typeof DigestAnswerSchema>;

/** Months (30.44 days) from `a` to `b`. */
export const monthsBetween = (a: string, b: string) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (30.44 * 24 * 3600 * 1000);

export interface FinalizeResult {
  goals: DigestGoal[];
  /** Goals the code moved from current to stale (the model's temporal slip), for logs and the eval. */
  demoted: number;
  /** Evidence lines dropped because their date is not a meeting in the history. */
  droppedEvidence: number;
}

/**
 * The answer → goals, with the temporal rules enforced in code:
 * - evidence only on dates that are meetings in the history (others dropped), at most 6;
 * - lastMentioned = the latest of the stated date and the evidence dates that are meetings;
 *   firstMentioned likewise the earliest; a goal with no valid date at all is dropped;
 * - "current" whose lastMentioned is more than STALE_MONTHS before the reference date → "stale";
 * - texts collapsed, cut, names scrubbed (`names`); duplicate titles merged (first kept).
 * Order: current, achieved, dropped, stale; within a status the most recently mentioned first.
 */
export function finalizeGoals(
  answer: DigestAnswer,
  history: HistoryMeeting[],
  opts: { referenceDate: string; staleMonths?: number; names?: string[]; /** Default true; false only for the eval's "raw" score. */ guard?: boolean },
): FinalizeResult {
  const stale = opts.staleMonths ?? STALE_MONTHS;
  const names = opts.names ?? [];
  const dates = new Set(history.map((m) => m.date));
  const clean = (s: string, max: number) => cut(collapse(scrubNames(collapse(s), names)), max);
  let demoted = 0;
  let droppedEvidence = 0;
  const seen = new Set<string>();
  const goals: DigestGoal[] = [];
  for (const g of answer.goals) {
    const title = clean(g.title, MAX_TITLE).replace(/[.]$/, "");
    if (!title || seen.has(title.toLowerCase())) continue;
    const evidence = g.evidence
      .map((e) => ({ date: e.date.trim().slice(0, 10), text: clean(e.text, MAX_EVIDENCE_TEXT) }))
      .filter((e) => {
        const ok = dates.has(e.date) && e.text.length > 0;
        if (!ok) droppedEvidence++;
        return ok;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const known = [...evidence.map((e) => e.date), ...[g.first_mentioned, g.last_mentioned].filter((d): d is string => Boolean(d && dates.has(d)))].sort();
    if (!known.length) continue;
    seen.add(title.toLowerCase());
    const lastMentioned = known.at(-1)!;
    let status: GoalStatus = g.status;
    if (opts.guard !== false && status === "current" && monthsBetween(lastMentioned, opts.referenceDate) > stale) {
      status = "stale";
      demoted++;
    }
    goals.push({
      title,
      status,
      why: clean(g.why, MAX_WHY),
      earlierNames: [...new Set(g.earlier_names.map((n) => clean(n, MAX_TITLE)).filter((n) => n && n.toLowerCase() !== title.toLowerCase()))],
      firstMentioned: known[0],
      lastMentioned,
      // The newest evidence is the most telling; keep the last MAX_EVIDENCE, oldest first.
      evidence: evidence.slice(-MAX_EVIDENCE),
    });
  }
  const rank = (s: GoalStatus) => GOAL_STATUSES.indexOf(s);
  goals.sort((a, b) => rank(a.status) - rank(b.status) || b.lastMentioned.localeCompare(a.lastMentioned));
  return { goals, demoted, droppedEvidence };
}

/** What the admin approves (org_goals holds at most this many). */
export const MAX_APPROVE = 5;

export interface GoalSuggestion {
  title: string;
  why: string | null;
  status: GoalStatus;
  lastMentioned: string;
  /** The dated lines the status rests on (newest last, at most 3). */
  evidence: { date: string; text: string }[];
}

export interface ProposedGoal {
  title: string;
  why: string | null;
  evidence: { date: string; text: string }[];
}

/**
 * The digest's goals → the editor's starting set (the current goals, at most MAX_APPROVE, most
 * recently mentioned first) and the rest as suggestions with their status. A goal's `why` is
 * the digest's sentence, cut to the approved goal's 240 characters.
 */
export function splitForApproval(goals: DigestGoal[]): { approve: ProposedGoal[]; others: GoalSuggestion[] } {
  const current = goals.filter((g) => g.status === "current");
  const evidence = (g: DigestGoal) => g.evidence.slice(-3);
  const approve = current.slice(0, MAX_APPROVE).map((g) => ({ title: g.title, why: g.why || null, evidence: evidence(g) }));
  const others = [...current.slice(MAX_APPROVE), ...goals.filter((g) => g.status !== "current")].map((g) => ({
    title: g.title,
    why: g.why || null,
    status: g.status,
    lastMentioned: g.lastMentioned,
    evidence: evidence(g),
  }));
  return { approve, others };
}
