import { countedMeetings, importedAt, itemLabel, underCheckin, type DashInput } from "@/lib/dashboard/overview";
import { normLabel } from "@/lib/agenda/scan";
import type { HistoryMeeting } from "@/lib/history/types";
import { isDecision, isTask } from "@/lib/meetings/summary";

// "Mål att ta upp" (todo #12): when a new agenda is prepared, at most two of the förening's approved
// goals (org_goals, Översikt → Mål) are offered as unticked agenda items, each with a one-line
// reason shown in the UI only (never in the Doc). Pure and deterministic, no Claude call:
//
// 1. A goal with a decision at a meeting in the last 3 weeks → "Följ upp beslutet från …".
// 2. A goal not mentioned at any meeting for 4 weeks or more, while the förening has met since
//    → "Inget nytt sedan 12 okt" (since the last mention, or since the goal was set).
//
// Decisions first (newest first), then the longest-quiet goals; ties in the goals' own order.
// "Mentioned": a meeting's agenda label, decision, task (or, in an imported protocol, topic or
// status line) shares the goal title's significant words (two of them, or its only one), compared
// on 5-letter stems so "medlemmar" ≈ "medlemsvärvning". A decision under an agenda item that names
// the goal ("Mål: Ny lokal") is a decision on it. Imported protocols (history_items) count too.
// org_goals holds only approved, current goals (set_org_goals replaces them all; there is no
// dropped/achieved state and no deadline), so every stored goal may be suggested. approved_at is
// the goal's first approval: 0042 keeps it (and the id) when the set is saved again.

export const MAX_GOAL_SUGGESTIONS = 2;
const DECISION_DAYS = 21;
const QUIET_DAYS = 28;
const DAY_MS = 24 * 3600 * 1000;

export interface GoalRow {
  id: string;
  title: string;
  approved_at: string;
}

/** One counted meeting as the rule sees it: when, and its words (labels, decisions, tasks). */
export interface GoalMeeting {
  at: string;
  /** Agenda labels, task texts (and an imported protocol's topics and status lines). */
  texts: string[];
  /** Decisions with the agenda item they sit under, when known. */
  decisions: { text: string; topic: string | null }[];
}

export interface GoalSuggestion {
  goalId: string;
  title: string;
  kind: "decision" | "quiet";
  /** One line for the UI ("Inget nytt sedan 12 okt"). */
  reason: string;
}

// Words that say nothing about which goal it is.
const STOP = new Set(
  "att och för med till från under inom utan över efter innan mellan genom eller samt även också inte mer mera fler flera bättre bra nya nytt alla allt egen eget egna våra vårt vår deras ska skall kunna göra blir vara varje mycket stor större stora hela året årets terminen kommande".split(
    " ",
  ),
);

const words = (s: string) => s.normalize("NFC").toLowerCase().match(/\p{L}+/gu) ?? [];
const stem = (w: string) => w.slice(0, 5);

/** The goal title's significant stems (words of 4+ letters, not stop words), deduplicated. */
export function goalStems(title: string): string[] {
  return [...new Set(words(title).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];
}

/** A text mentions the goal: it has two of its stems (or its only one). */
export function mentions(stems: string[], text: string): boolean {
  if (!stems.length) return false;
  const have = new Set(words(text).filter((w) => w.length >= 4).map(stem));
  const hits = stems.filter((s) => have.has(s)).length;
  return hits >= Math.min(2, stems.length);
}

/** "12 okt" (Europe/Stockholm). */
export function shortDay(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }).format(new Date(iso)).replace(".", "");
}

/**
 * The counted meetings' words, oldest first; Må-runda items and Testmöten never count. `imported`:
 * old protocols (history_items), as their own meetings.
 */
export function goalMeetings(orgId: string, input: Pick<DashInput, "meetings" | "items">, imported: HistoryMeeting[] = []): GoalMeeting[] {
  const meetings = countedMeetings(orgId, input.meetings);
  const byId = new Map(meetings.map((m) => [m.id, { at: m.started_at, texts: [] as string[], decisions: [] as GoalMeeting["decisions"] }]));
  for (const m of meetings) {
    for (const [anchor, label] of Object.entries(m.agenda_labels ?? {})) {
      if (typeof label === "string" && m.agenda_roles?.[anchor] !== "checkin") byId.get(m.id)!.texts.push(label);
    }
  }
  const meetingOf = new Map(meetings.map((m) => [m.id, m]));
  for (const r of input.items) {
    const gm = byId.get(r.meeting_id);
    const m = meetingOf.get(r.meeting_id);
    if (!gm || !m || underCheckin(m, r) || r.deleted_by_human) continue;
    if (isDecision(r)) gm.decisions.push({ text: r.text, topic: itemLabel(m, r.anchor) });
    else if (isTask(r)) gm.texts.push(r.text);
  }
  const own = meetings.map((m) => byId.get(m.id)!);
  const old = imported.map((h) => {
    const gm: GoalMeeting = { at: importedAt(h.date), texts: [], decisions: [] };
    for (const i of h.items) {
      if (i.kind === "decision") gm.decisions.push({ text: i.text, topic: i.topic });
      else {
        gm.texts.push(i.text);
        if (i.topic) gm.texts.push(i.topic);
      }
    }
    return gm;
  });
  return [...old, ...own].sort((a, b) => a.at.localeCompare(b.at));
}

const decidedOn = (stems: string[], d: GoalMeeting["decisions"][number]) => mentions(stems, d.text) || (d.topic !== null && mentions(stems, d.topic));

/**
 * At most two goals to bring up, with why (see the rules above). `goals` in their own order.
 * `from`: the start of the window `meetings` cover (the loader reads a bounded window); a goal not
 * mentioned in it is quiet since the later of its approval and `from` (true either way).
 */
export function suggestGoals(goals: GoalRow[], meetings: GoalMeeting[], now: Date, opts: { from?: string } = {}): GoalSuggestion[] {
  const nowMs = now.getTime();
  const sorted = [...meetings].sort((a, b) => a.at.localeCompare(b.at));
  type Scored = GoalSuggestion & { order: number; at: number };
  const decided: Scored[] = [];
  const quiet: Scored[] = [];
  goals.forEach((g, order) => {
    const stems = goalStems(g.title);
    let lastMention: string | null = null;
    let lastDecision: string | null = null;
    for (const m of sorted) {
      if (Date.parse(m.at) > nowMs) continue;
      const decision = m.decisions.some((d) => decidedOn(stems, d));
      if (decision) lastDecision = m.at;
      if (decision || m.texts.some((t) => mentions(stems, t))) lastMention = m.at;
    }
    if (lastDecision && nowMs - Date.parse(lastDecision) <= DECISION_DAYS * DAY_MS) {
      const ago = nowMs - Date.parse(lastDecision);
      const reason = ago <= 10 * DAY_MS ? "Följ upp beslutet från förra veckan" : `Följ upp beslutet från ${shortDay(lastDecision)}`;
      decided.push({ goalId: g.id, title: g.title, kind: "decision", reason, order, at: Date.parse(lastDecision) });
      return;
    }
    const floor = opts.from && Date.parse(opts.from) > Date.parse(g.approved_at) ? opts.from : g.approved_at;
    const since = lastMention ?? floor;
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs) || nowMs - sinceMs < QUIET_DAYS * DAY_MS) return;
    // Only when the förening has met since: a quiet goal of a förening that hasn't met says nothing.
    if (!sorted.some((m) => Date.parse(m.at) > sinceMs && Date.parse(m.at) <= nowMs)) return;
    quiet.push({ goalId: g.id, title: g.title, kind: "quiet", reason: `Inget nytt sedan ${shortDay(since)}`, order, at: sinceMs });
  });
  decided.sort((a, b) => b.at - a.at || a.order - b.order);
  quiet.sort((a, b) => a.at - b.at || a.order - b.order);
  return [...decided, ...quiet].slice(0, MAX_GOAL_SUGGESTIONS).map(({ goalId, title, kind, reason }) => ({ goalId, title, kind, reason }));
}

/** The agenda item's label and draft id for a goal. */
export const goalLabel = (title: string) => `Mål: ${title.trim()}`;
export const goalItemId = (title: string) => `goal:${normLabel(title)}`;

/** At most this many characters of a goal title in an agenda label (org_goals allows 80). */
const GOAL_LABEL_MAX = 120;

/**
 * Starta möte with a new Doc (todo #12): the format with the ticked goals as topic items, after its
 * own items and before "Övriga punkter" (and the "last" ones). Only this meeting's Doc and anchoring
 * see it; the stored format is unchanged.
 */
export function withGoalItems<P extends { fixedAgendaItems: { key: string; label: string; role: string; position?: "last" }[] }>(profile: P, titles: string[]): P {
  if (!titles.length) return profile;
  const keys = new Set(profile.fixedAgendaItems.map((i) => i.key));
  const added: P["fixedAgendaItems"] = [];
  titles.forEach((title) => {
    const label = goalLabel(title).slice(0, GOAL_LABEL_MAX);
    if ([...profile.fixedAgendaItems, ...added].some((i) => i.label.toLowerCase() === label.toLowerCase())) return;
    let n = added.length + 1;
    while (keys.has(`goal-${n}`)) n++;
    keys.add(`goal-${n}`);
    added.push({ key: `goal-${n}`, label, role: "topic" });
  });
  return { ...profile, fixedAgendaItems: [...profile.fixedAgendaItems, ...added] };
}
