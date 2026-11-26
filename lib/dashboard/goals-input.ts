import { z } from "zod";
import { isDecision } from "@/lib/meetings/summary";
import { countedMeetings, itemLabel, openTasks, recurringTopics, underCheckin, type DashInput } from "./overview";

// What "Föreslå mål" sends Claude (pure, so the privacy rules are tested without a call): the
// structure Simon Says already stored about the förening's real meetings. No owners, no
// attendance, no Doc text, no Testmöte, nothing under a Må-runda item; people's names in the
// texts become "en person".

export const MIN_MEETINGS = 3;
export const MAX_DECISIONS = 60;
export const MAX_TASKS = 30;
const MAX_TEXT = 200;
export const MAX_GOALS = 5;
export const GOAL_TITLE_MAX = 80;
export const GOAL_WHY_MAX = 240;

export interface GoalsInput {
  meetings: number;
  from: string;
  to: string;
  topics: { label: string; meetings: number; decisions: number }[];
  decisions: { month: string; item: string | null; text: string }[];
  openTasks: { since: string; text: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each person's full name, then each name part (≥ 2 letters, also genitive), with "en person". */
export function scrubNames(text: string, names: string[]): string {
  const parts = [...new Set(names.flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)]).filter((p) => p.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const p of parts) out = out.replace(new RegExp(`(?<![\\p{L}])${escape(p)}s?(?![\\p{L}])`, "giu"), "en person");
  return out;
}

const clip = (s: string) => {
  const t = s.normalize("NFC").replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

/** Null when there are fewer than MIN_MEETINGS counted meetings (no call then). */
export function goalsInput(orgId: string, input: DashInput, now: Date): GoalsInput | null {
  const meetings = countedMeetings(orgId, input.meetings);
  if (meetings.length < MIN_MEETINGS) return null;
  const names = input.people.map((p) => p.name);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const text = (s: string) => clip(scrubNames(s, names));
  const decisions = input.items
    .filter((r) => byId.has(r.meeting_id) && isDecision(r) && !underCheckin(byId.get(r.meeting_id)!, r))
    .map((r) => ({ r, m: byId.get(r.meeting_id)! }))
    .sort((a, b) => b.m.started_at.localeCompare(a.m.started_at) || a.r.position - b.r.position)
    .slice(0, MAX_DECISIONS)
    .map(({ r, m }) => ({ month: m.started_at.slice(0, 7), item: itemLabel(m, r.anchor), text: text(r.text) }));
  const topics = recurringTopics(orgId, input).map((t) => ({
    label: t.label,
    meetings: t.meetings,
    decisions: t.months.reduce((n, m) => n + m.decisions.length, 0),
  }));
  const tasks = openTasks(orgId, input, now)
    .flatMap((g) => g.tasks)
    .sort((a, b) => a.since.localeCompare(b.since))
    .slice(0, MAX_TASKS)
    .map((t) => ({ since: t.since.slice(0, 7), text: text(t.text) }));
  return {
    meetings: meetings.length,
    from: meetings[0].started_at.slice(0, 10),
    to: meetings.at(-1)!.started_at.slice(0, 10),
    topics,
    decisions,
    openTasks: tasks,
  };
}

/** One goal as the admin approves it (the browser sends these back; validated again). */
export const GoalSchema = z.object({
  title: z.string().transform((s) => s.normalize("NFC").replace(/\s+/g, " ").trim()).pipe(z.string().min(1).max(GOAL_TITLE_MAX)),
  why: z
    .string()
    .nullish()
    .transform((s) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(z.string().max(GOAL_WHY_MAX))
    .transform((s) => s || null),
});
export const GoalsSchema = z.array(GoalSchema).max(MAX_GOALS);
export type Goal = z.infer<typeof GoalSchema>;
