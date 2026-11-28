import "server-only";
import { agentState, canUpdateAgentTask, isAgentTask, statusMap, statusKey, type AgentState, type AgentStatus } from "@/lib/agent/tasks";
import type { ItemRole } from "@/lib/db/types";
import { isUuid } from "@/lib/db/ids";
import { buildOrgMeeting } from "@/lib/home/meeting";
import { stockholmDay, taskTips, visible, type HomeNoteRow } from "@/lib/home/tasks";
import { isTask } from "@/lib/meetings/summary";
import { attributedLine, attributionOf } from "@/lib/memory/attribution";
import { allSources, clean, MEMORY_SECTIONS, parseLines, visibleLines } from "@/lib/memory/memory";
import { appOrigin } from "@/lib/origin";
import { summaryContent } from "@/lib/summaries/content";
import { docUrl } from "@/lib/ui/meetings";
import type { McpMeeting, McpOrg } from "./reader";
import { actorFor, page, parseTaskId, type ToolCtx, type ToolResult } from "./tools";

// The tools of docs/superpowers/specs/2026-11-28-claude-tasks-memory-design.md:
// - list_agent_tasks / update_agent_task: tasks a meeting explicitly gave Claude (lib/agent/tasks.ts),
//   read through the reader (mcp_* functions, the RLS predicates for this user) and the app's own
//   builders (taskTips, visible, buildOrgMeeting, summaryContent), so a brief holds only what the
//   app shows this user of that meeting; never the transcript.
// - get_org_memory: "Vad Claude ska veta", a line with sources only when the user can see them all.

const refuse = (error: string): ToolResult => ({ ok: false, error });
const ok = (data: unknown): ToolResult => ({ ok: true, data });

/** Meetings read per space for the agent task list (as /hem). */
const MEETINGS_PER_SPACE = 60;
const MAX_CONTEXT = 8;
const MAX_NOTE = 500;

type Filter = AgentState | "all";
const isOpen = (s: AgentState) => s !== "done";

const meetingUrl = (ctx: ToolCtx, orgId: string, meetingId: string) => `${ctx.origin ?? appOrigin()}/orgs/${orgId}/mote/${meetingId}`;

/** The note-taking spaces (förening, Företag) and their finished meetings the user can see. */
async function noteSpaces(ctx: ToolCtx, onlyOrg?: string) {
  const orgs = (await ctx.reader.orgs()).filter((o) => o.kind !== "privat" && (!onlyOrg || o.id === onlyOrg));
  const meetings: McpMeeting[] = [];
  for (const o of orgs) meetings.push(...(await ctx.reader.meetings({ org: o.id, done: true, limit: MEETINGS_PER_SPACE })));
  return { orgs, meetings };
}

export async function listAgentTasks(ctx: ToolCtx, args: { status?: Filter; include_others?: boolean; cursor?: string; limit?: number }): Promise<ToolResult> {
  const filter: Filter = args.status ?? "open";
  // By default only the tasks this user gave Claude (or may move as an admin): a line anyone said in
  // a meeting the user merely sees is no assignment from the user.
  const others = args.include_others === true;
  const { orgs, meetings } = await noteSpaces(ctx);
  if (!meetings.length) return ok({ tasks: [], next_cursor: null });
  const orgOf = new Map<string, McpOrg>(orgs.map((o) => [o.id, o]));
  const ids = meetings.map((m) => m.id);
  const [rows, people, statusRows] = await Promise.all([ctx.reader.noteItems(ids), ctx.reader.people(orgs.map((o) => o.id)), ctx.reader.agentStatuses(ids)]);
  const statuses = statusMap(statusRows);
  const byMeeting = new Map(meetings.map((m) => [m.id, m]));
  const found = taskTips(rows.filter((r) => r.section === "action") as HomeNoteRow[], meetings)
    .filter((r) => isAgentTask(r, people.filter((p) => p.org_id === byMeeting.get(r.meeting_id)!.org_id)))
    .map((r) => ({ r, m: byMeeting.get(r.meeting_id)!, state: agentState(r.done, statuses.get(statusKey(r.meeting_id, r.id))) }))
    .filter((t) => (filter === "all" ? true : filter === "open" ? isOpen(t.state.status) : t.state.status === filter))
    .filter((t) => others || canUpdateAgentTask({ userId: ctx.user.id, startedBy: t.m.started_by, isAdmin: orgOf.get(t.m.org_id)?.role === "admin" }))
    .sort((a, b) => b.m.started_at.localeCompare(a.m.started_at) || a.r.position - b.r.position);
  const { items, next_cursor } = page(found, args.cursor, args.limit);

  return ok({
    tasks: items.map(({ r, m, state }) => {
      const org = orgOf.get(m.org_id)!;
      const roles = (m.agenda_roles ?? {}) as Record<string, ItemRole>;
      const mine = [...rows.filter((x) => x.meeting_id === m.id)].sort((a, b) => a.position - b.position) as HomeNoteRow[];
      const built = buildOrgMeeting({ userId: ctx.user.id, org: { id: org.id, name: org.name }, meeting: m, role: org.role, rows: mine, people: people.filter((p) => p.org_id === org.id) });
      const other = summaryContent(mine.filter((x) => x.section === "note"), { agendaRoles: roles }).other;
      return {
        task_id: `n:${m.id}:${r.id}`,
        task: clean(r.text),
        done_when: clean(r.done_when) || null,
        due: clean(r.due) || null,
        due_date: r.due_date ?? null,
        status: state.status,
        note: state.note,
        can_update: canUpdateAgentTask({ userId: ctx.user.id, startedBy: m.started_by, isAdmin: org.role === "admin" }),
        meeting: {
          meeting_id: m.id,
          title: built.meeting.title,
          date: stockholmDay(m.started_at),
          org: org.name,
          org_kind: org.kind,
          url: meetingUrl(ctx, org.id, m.id),
          doc_url: m.doc_id ? docUrl(m.doc_id) : null,
        },
        context: {
          decisions: built.decisions.slice(0, MAX_CONTEXT),
          other_notes: other.slice(0, MAX_CONTEXT),
        },
      };
    }),
    next_cursor,
  });
}

export async function updateAgentTask(ctx: ToolCtx, args: { task_id: string; status: AgentStatus; note?: string }): Promise<ToolResult> {
  const parsed = parseTaskId(args.task_id);
  if (!parsed || parsed.kind !== "note") return refuse("Unknown task_id. Use a task_id from list_agent_tasks.");
  ctx.ids.task_id = args.task_id;
  ctx.ids.meeting_id = parsed.meetingId;
  const note = args.note === undefined ? null : clean(args.note) || null;
  if (note && note.length > MAX_NOTE) return refuse(`note must be at most ${MAX_NOTE} characters.`);
  const notFound = refuse("Task not found, or you can't see it.");

  const [m] = await ctx.reader.meetings({ ids: [parsed.meetingId], done: false, limit: 1 });
  if (!m || m.id !== parsed.meetingId) return notFound;
  const org = (await ctx.reader.orgs()).find((o) => o.id === m.org_id);
  if (!org || org.kind === "privat") return notFound;
  ctx.ids.org_id = org.id;
  if (m.status !== "done" || m.is_test) return refuse("That meeting is not finished (or is a Testmöte).");
  const [rows, people, statuses] = await Promise.all([ctx.reader.noteItems([m.id]), ctx.reader.people([org.id]), ctx.reader.agentStatuses([m.id])]);
  const row = rows.find((r) => r.id === parsed.itemId) as HomeNoteRow | undefined;
  const chain = row && { ...row, kind: row.kind ?? null, done: row.done ?? false, copy_of: row.copy_of ?? null, carried_from_meeting: row.carried_from_meeting ?? null, carried_from_id: row.carried_from_id ?? null };
  if (!row || !chain || !isTask(chain) || !visible(row, (m.agenda_roles ?? {}) as Record<string, ItemRole>)) return notFound;
  if (!isAgentTask(row, people)) return refuse("That task isn't Claude's: only tasks the meeting gave Claude (Vem: Claude) can be updated here. Use complete_task for the user's own tasks.");
  if (!canUpdateAgentTask({ userId: ctx.user.id, startedBy: m.started_by, isAdmin: org.role === "admin" })) {
    return refuse("Only the person who ran the meeting (who gave Claude the task) or an admin can update it.");
  }
  const before = agentState(Boolean(row.done), statuses.find((s) => s.item_id === row.id));
  if (before.status === "done") return refuse("That task is already done.");

  if (args.status !== "done") {
    if (!(await ctx.reader.setAgentTask(m.id, row.id, args.status, note))) return notFound;
    return ok({ task_id: args.task_id, status: args.status, note: note ?? before.note, meeting_url: meetingUrl(ctx, org.id, m.id) });
  }

  // Done: the same path as ticking it in the app (note row, Från förra veckan chain, "✓ klart" in the Doc).
  const db = await actorFor(ctx, { meetingId: m.id });
  if (!db) return notFound;
  const result = await ctx.deps.completeNoteTask(db, ctx.user.id, m.id, row.id);
  if (!result.ok) return result.error === "forbidden" ? refuse("Only the person who ran the meeting or an admin can complete it.") : notFound;
  if (!(await ctx.reader.setAgentTask(m.id, row.id, "done", note))) console.error("mcp: update_agent_task: status row not written");
  const docNote: Record<string, string> = {
    written: "Marked ✓ klart in the meeting's Google Doc too.",
    locked: "Done in Simon Says. Someone edited that line in the Doc, so it was left alone.",
    failed: "Done in Simon Says, but the Google Doc could not be updated right now.",
    none: "Done.",
  };
  return ok({ task_id: args.task_id, status: "done", note: note ?? before.note, doc: result.doc, doc_note: docNote[result.doc], meeting_url: meetingUrl(ctx, org.id, m.id) });
}

export async function getOrgMemory(ctx: ToolCtx, args: { org_id: string }): Promise<ToolResult> {
  if (!isUuid(args.org_id)) return refuse("Unknown org_id. Call list_spaces for your spaces.");
  ctx.ids.org_id = args.org_id;
  const org = (await ctx.reader.orgs()).find((o) => o.id === args.org_id);
  if (!org) return refuse("Unknown org_id (or you are not a member). Call list_spaces for your spaces.");
  if (org.kind === "privat") return refuse("A Privat space has no shared memory; use search_meetings for its recordings.");
  const row = await ctx.reader.orgMemory(org.id);
  const lines = parseLines(row?.lines);
  // A line with sources only for a user who can (still) see every one of them.
  const sources = allSources(lines);
  const seen = sources.length ? await ctx.reader.meetings({ ids: sources, done: false, limit: Math.min(sources.length, 1000) }) : [];
  const shown = visibleLines(lines, new Set(seen.map((m) => m.id)));
  const date = new Map(seen.map((m) => [m.id, stockholmDay(m.started_at)]));
  const dates = Object.fromEntries(date);
  return ok({
    org: org.name,
    org_kind: org.kind,
    updated_at: row?.updated_at ?? null,
    built_from: row?.generated_at ? { meetings: row.sources_count ?? 0, since: row.sources_from ? row.sources_from.slice(0, 10) : null } : null,
    sections: Object.fromEntries(
      MEMORY_SECTIONS.map((s) => [
        s,
        shown
          .filter((l) => l.section === s)
          .map((l) => {
            // Every line is an attributed statement ("Sades i mötet 12 nov: …"), never a bare claim.
            const a = attributionOf(l);
            return {
              text: attributedLine(l, dates, "sv"),
              statement: l.text,
              ...(a.kind === "said"
                ? { said_in: a.meetingIds.map((id) => ({ meeting_id: id, date: date.get(id) ?? null, url: meetingUrl(ctx, org.id, id) })) }
                : { added_by: a.by }),
              sources: l.sources.map((id) => ({ meeting_id: id, date: date.get(id) ?? null, url: meetingUrl(ctx, org.id, id) })),
            };
          }),
      ]),
    ),
    ...(lines.length ? {} : { note: "No memory yet. An admin can build it in Simon Says: Inställningar → Vad Claude ska veta → Uppdatera." }),
  });
}
