import { z } from "zod";
import { labelsMatch, normLabel } from "@/lib/agenda/scan";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { formatLine, type LineCtx } from "@/lib/docs/format-render";
import type { FormatKind, FormatProfile } from "@/lib/formats/schema";
import { mergeRequiredItems } from "@/lib/formats/skeleton";
import { goalItemId, goalLabel, type GoalSuggestion } from "./goals";

// "Förbered möte" (todo #6): the draft agenda Simon Says proposes before a meeting, from data
// only (no Claude call): the format's standing items, "Från förra veckan" filled with the
// previous meeting's open tasks, and topics that recur at several meetings (Översikt), offered
// unticked. The ordförande adds what Simon Says can't know, reorders and removes. Pure.

export { MEETING_TYPES, isMeetingType, meetingTypeName } from "./types";
export type { DraftItem, DraftSource, DraftTask, FollowupOrigin, MeetingType } from "./types";
import type { DraftItem, FollowupOrigin, MeetingType } from "./types";

/** The format kinds whose meetings count as "the same kind" of meeting (v1 meetings, no format, are weekly ones). */
export function kindsOfType(type: MeetingType): (FormatKind | null)[] {
  if (type === "styrelsemote") return ["styrelseprotokoll"];
  if (type === "arsmote") return ["arsmote"];
  return ["veckomote", "learned", "enkel", null];
}

/** The standard format kind a meeting type falls back to. */
export function standardKindOf(type: MeetingType): "veckomote" | "styrelseprotokoll" | "arsmote" {
  return type === "styrelsemote" ? "styrelseprotokoll" : type;
}

export const sourceKey = (meetingId: string, itemId: string) => `${meetingId}:${itemId}`;

/**
 * The draft for a new prepared agenda.
 * - standing items: the format's fixed items (stadgar items merged in), "last" ones at the end;
 * - the follow-up item lists `carried` (rows as `carriedItems` makes them) as lines;
 * - `topics` (Översikt's recurring topics) that no standing item names: suggestions, unticked,
 *   before the "last" items;
 * - `goals` ("Mål att ta upp", lib/prepare/goals.ts): at most two goals as unticked "Mål: <titel>"
 *   suggestions with their reason, after the topics.
 */
export function buildDraft(input: {
  profile: FormatProfile;
  carried: NoteItemRow[];
  ctx: LineCtx;
  topics: { label: string; meetings: number }[];
  /** Where the carried tasks come from (shown under "Från förra veckan"). */
  origin?: FollowupOrigin;
  goals?: GoalSuggestion[];
}): DraftItem[] {
  const fixed = mergeRequiredItems(input.profile);
  const tasks = input.carried.map((r) => ({
    source: sourceKey(r.carried_from_meeting ?? "", r.carried_from_id ?? r.id),
    line: formatLine({ section: "action", text: r.text, owner: r.owner ?? undefined, due: r.due ?? undefined }, input.ctx),
    on: true,
  }));
  const standing = (last: boolean): DraftItem[] =>
    fixed
      .filter((i) => (i.position === "last") === last)
      .map((i) => ({
        id: `std:${i.key}`,
        label: i.label,
        role: i.role,
        source: "standing" as const,
        on: true,
        ...(last ? { last: true } : {}),
        ...(i.role === "followup" ? { tasks, ...(input.origin ? { origin: input.origin } : {}) } : {}),
      }));
  const seen = new Set<string>();
  const suggestions: DraftItem[] = [];
  for (const t of input.topics) {
    const n = normLabel(t.label);
    if (!n || seen.has(n) || fixed.some((i) => labelsMatch(i.label, t.label))) continue;
    seen.add(n);
    suggestions.push({ id: `topic:${n}`, label: t.label.trim(), role: "topic", source: "suggested", on: false, meetings: t.meetings });
  }
  const goals: DraftItem[] = [];
  for (const g of input.goals ?? []) {
    const id = goalItemId(g.title);
    if (id === "goal:" || goals.some((x) => x.id === id)) continue;
    goals.push({ id, label: goalLabel(g.title), role: "topic", source: "suggested", on: false, reason: g.reason });
  }
  return [...standing(false), ...suggestions, ...goals, ...standing(true)];
}

/**
 * A stored draft brought up to date for preparing again: the follow-up item's tasks are the
 * current open ones (`fresh`, from buildDraft), ticked unless the ordförande took the task off
 * (`dropped`); everything else is the stored draft as approved.
 */
export function refreshDraft(stored: DraftItem[], fresh: DraftItem[], dropped: Set<string>): DraftItem[] {
  const f = fresh.find((i) => i.tasks);
  const tasks = f?.tasks ?? [];
  // A goal's reason is always today's (never stored): from the fresh draft, or none.
  const reasons = new Map(fresh.filter((i) => i.reason).map((i) => [i.id, i.reason!]));
  // An unticked goal Simon Says no longer suggests (removed from the goals, or no longer due) goes.
  const kept = stored.filter((i) => !(i.id.startsWith("goal:") && !i.on && !reasons.has(i.id)));
  return kept.map((i) => {
    if (i.id.startsWith("goal:")) {
      const { reason: _old, ...rest } = i;
      const reason = reasons.get(i.id);
      return reason ? { ...rest, reason } : rest;
    }
    if (i.role !== "followup") return i;
    const { origin: _old, ...rest } = i;
    return { ...rest, tasks: tasks.map((t) => ({ ...t, on: !dropped.has(t.source) })), ...(f?.origin ? { origin: f.origin } : {}) };
  });
}

/** The items that go into the Doc, in order (unticked suggestions and removed items left out). */
export const agendaItems = (items: DraftItem[]) => items.filter((i) => i.on);

/** Carried sources the ordförande took off the agenda (unticked tasks, or the whole follow-up item). */
export function droppedSources(items: DraftItem[]): string[] {
  const out: string[] = [];
  for (const i of items) for (const t of i.tasks ?? []) if (!t.on || !i.on) out.push(t.source);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The request body ("Skapa dagordning"): labels and order from the client, roles from the server.

const label = z.string().trim().min(1).max(120);

export const PrepareBodySchema = z.object({
  type: z.enum(["veckomote", "styrelsemote", "arsmote"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z
    .string()
    .regex(/^[0-2]\d:[0-5]\d$/)
    .nullable()
    .optional(),
  /** The calendar event it was prepared from (todo #14): its title goes into the Doc's name. */
  eventTitle: z.string().max(300).nullable().optional(),
  items: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(160),
        label,
        source: z.enum(["standing", "suggested", "added"]),
        on: z.boolean(),
        tasks: z.array(z.object({ source: z.string().min(1).max(160), on: z.boolean() })).max(200).optional(),
      }),
    )
    .min(1)
    .max(40),
});
export type PrepareBody = z.infer<typeof PrepareBodySchema>;

/** A real calendar date (2026-02-30 is not). */
export function validDate(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/**
 * The client's items as the draft to store: a standing item keeps the format's role (never the
 * client's), anything else is a topic; tasks keep the server's lines (from `server`), only their
 * tick comes from the client. Unknown standing ids are dropped. Null when no item is left on.
 */
export function normaliseItems(body: PrepareBody["items"], server: DraftItem[]): DraftItem[] | null {
  const byId = new Map(server.filter((i) => i.source === "standing").map((i) => [i.id, i]));
  const serverTasks = server.find((i) => i.tasks)?.tasks ?? [];
  const seen = new Set<string>();
  const out: DraftItem[] = [];
  for (const it of body) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (it.source === "standing") {
      const std = byId.get(it.id);
      if (!std) continue;
      const ticks = new Map((it.tasks ?? []).map((t) => [t.source, t.on]));
      out.push({
        ...std,
        // The follow-up item keeps the format's label: the start finds it by that label.
        label: std.role === "followup" ? std.label : it.label,
        on: it.on,
        ...(std.tasks ? { tasks: serverTasks.map((t) => ({ ...t, on: ticks.get(t.source) ?? true })) } : {}),
      });
    } else {
      out.push({ id: it.id, label: it.label, role: "topic", source: it.source, on: it.on });
    }
  }
  return out.some((i) => i.on) ? out : null;
}
