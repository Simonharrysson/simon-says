import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { ItemRole } from "@/lib/db/types";
import { isUuid } from "@/lib/db/ids";
import { localDate } from "@/lib/docs/create";
import { getEnv } from "@/lib/env";
import { completeNoteTask } from "@/lib/home/complete";
import { buildOrgMeeting } from "@/lib/home/meeting";
import { excerpt, firstSourceMs, type MomentLine } from "@/lib/meetings/moments";
import { formatSaidAt } from "@/lib/notes/sources";
import { myForeningTasks, myHandoffTasks, myPrivatTasks, sortTasks, visible, type HomeNoteRow, type HomeSpace } from "@/lib/home/tasks";
import { addItem, bodyItems } from "@/lib/prepare/edit";
import { loadDraft, savePrepared } from "@/lib/prepare/prepare";
import { upcomingPrepared } from "@/lib/prepare/store";
import { proposedWhen } from "@/lib/prepare/when";
import { summaryContent } from "@/lib/summaries/content";
import { docUrl } from "@/lib/ui/meetings";
import type { McpMeeting, McpOrg, McpReader } from "./reader";

// The MCP tools (docs/superpowers/specs/2026-11-27-mcp-design.md "Tools v1").
// - Reads go only through `ctx.reader` (the mcp_* functions of 0060: the RLS predicates, for this
//   user) and the app's pure builders (buildOrgMeeting, myForeningTasks …, summaryContent, visible),
//   so a tool never shows more than the app shows that user.
// - Writes go through the app's own server paths with this user as the actor and their permission
//   checks unchanged: completeNoteTask (owner or admin), set_task_handoff_done, the Privat update,
//   Förbered möte (loadDraft → addItem → savePrepared), each only after the reader has shown the
//   meeting or förening to be the user's.
// Results are compact JSON; lists are paginated. The ids a call touched go to the audit log
// (`ctx.ids`), never any text.

export interface ToolDeps {
  completeNoteTask: typeof completeNoteTask;
  upcomingPrepared: typeof upcomingPrepared;
  loadDraft: typeof loadDraft;
  savePrepared: typeof savePrepared;
  /**
   * The client the app's write paths run on for this actor: their checks read by explicit ids
   * (meeting, org, user), and `auth.getUser()` answers with the actor. Used only after the reader
   * has shown the meeting or förening to be the user's.
   */
  actorClient: (user: User) => SupabaseClient;
}

/** A fresh service-role client whose auth.getUser() is the actor (never the shared singleton). */
export function actorClient(user: User): SupabaseClient {
  const env = getEnv();
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  db.auth.getUser = (async () => ({ data: { user }, error: null })) as typeof db.auth.getUser;
  return db;
}

export const defaultToolDeps: ToolDeps = { completeNoteTask, upcomingPrepared, loadDraft, savePrepared, actorClient };

/**
 * The ONLY way a tool gets the actor client: the reader (the mcp_* functions, RLS predicates for
 * this user) must show the scope first, here, right before the write. Never call
 * `ctx.deps.actorClient` directly: a write path that skipped this would act on rows the user can't
 * see (the actor client is the service role). Null when the scope isn't the user's.
 */
export async function actorFor(ctx: ToolCtx, scope: { meetingId: string } | { foreningId: string }): Promise<SupabaseClient | null> {
  if ("meetingId" in scope) {
    const [m] = await ctx.reader.meetings({ ids: [scope.meetingId], done: false, limit: 1 });
    if (!m || m.id !== scope.meetingId) return null;
  } else {
    const org = (await ctx.reader.orgs()).find((o) => o.id === scope.foreningId);
    if (!org || org.kind !== "forening") return null;
  }
  return ctx.deps.actorClient(ctx.user);
}

export interface ToolCtx {
  reader: McpReader;
  user: User;
  deps: ToolDeps;
  now: Date;
  /** The app's origin, for links to meeting pages (the handler's; appOrigin() when absent). */
  origin?: string;
  /** Ids this call touched, for the audit row (filled by the tool). */
  ids: Record<string, string>;
}

/** A tool's answer: data for Claude, or a refusal it should relay. */
export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const refuse = (error: string): ToolResult => ({ ok: false, error });
const ok = (data: unknown): ToolResult => ({ ok: true, data });

export const MAX_LIMIT = 25;
export const DEFAULT_LIMIT = 10;
/** search_meetings looks at this many of the newest meetings in range (narrow with from/to). */
export const SEARCH_WINDOW = 300;
/** my_tasks reads this many finished meetings per space (as /hem). */
const MEETINGS_PER_SPACE = 60;
const SNIPPET = 160;
const MAX_SUMMARY_LINES = 8;

const clean = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/** The page of `all` after `cursor` (an offset as text) and the next cursor, if any. */
export function page<T>(all: T[], cursor: string | undefined, limit: number | undefined): { items: T[]; next_cursor: string | null } {
  const start = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0;
  const size = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const items = all.slice(start, start + size);
  return { items, next_cursor: start + size < all.length ? String(start + size) : null };
}

/** At most SNIPPET characters of `text` around the first match of `q`. */
export function snippet(text: string, q: string): string {
  const t = clean(text);
  if (t.length <= SNIPPET) return t;
  const at = Math.max(0, t.toLowerCase().indexOf(q.toLowerCase()));
  const from = Math.max(0, Math.min(at - 40, t.length - SNIPPET));
  return `${from > 0 ? "…" : ""}${t.slice(from, from + SNIPPET - 2).trim()}${from + SNIPPET - 2 < t.length ? "…" : ""}`;
}

/** A query for ilike: % _ and \ are literal. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const spacesOf = (orgs: McpOrg[]) => [...orgs].sort((a, b) => a.name.localeCompare(b.name, "sv"));

/** Föreningar, Företag and the user's Privat space with its contexts (a course, a client, a project). */
export async function listSpaces(ctx: ToolCtx): Promise<ToolResult> {
  const spaces = spacesOf(await ctx.reader.orgs());
  const privat = spaces.filter((s) => s.kind === "privat").map((s) => s.id);
  const contexts = await ctx.reader.contexts(privat);
  return ok({
    spaces: spaces.map((s) => ({
      org_id: s.id,
      name: s.name,
      kind: s.kind,
      role: s.role,
      ...(s.kind === "privat"
        ? { contexts: contexts.filter((c) => c.org_id === s.id).sort((a, b) => a.name.localeCompare(b.name, "sv")).map((c) => ({ context_id: c.id, name: c.name })) }
        : {}),
    })),
  });
}

export async function searchMeetings(
  ctx: ToolCtx,
  args: { query?: string; org_id?: string; context_id?: string; from?: string; to?: string; cursor?: string; limit?: number },
): Promise<ToolResult> {
  const spaces = await ctx.reader.orgs();
  if (args.org_id) ctx.ids.org_id = args.org_id;
  if (args.context_id) ctx.ids.context_id = args.context_id;
  if (args.org_id && !spaces.some((s) => s.id === args.org_id)) return refuse("Unknown org_id (or you are not a member). Call list_spaces for your spaces.");
  const q = clean(args.query);
  if (q && (q.length < 2 || q.length > 100)) return refuse("query must be 2 to 100 characters.");

  const inRange = await ctx.reader.meetings({
    org: args.org_id ?? null,
    from: args.from ? `${args.from}T00:00:00Z` : null,
    to: args.to ? `${args.to}T23:59:59Z` : null,
    done: true,
    limit: SEARCH_WINDOW,
  });
  // A Privat context (a course, a client): its recordings only.
  const meetings = args.context_id ? inRange.filter((m) => m.context_id === args.context_id) : inRange;
  const spaceOf = new Map(spaces.map((s) => [s.id, s]));
  // Privat recordings are titled by their context ("TDDE15").
  const contexts = await ctx.reader.contexts(spaces.filter((s) => s.kind === "privat").map((s) => s.id));
  const contextName = new Map(contexts.map((c) => [c.id, c.name]));
  const titleOf = (m: McpMeeting) => clean(m.title) || (m.context_id ? (contextName.get(m.context_id) ?? null) : null);

  let hits: { m: McpMeeting; snippet: string | null }[];
  if (!q) {
    hits = meetings.map((m) => ({ m, snippet: null }));
  } else {
    const found = new Map<string, string>();
    const lower = q.toLowerCase();
    for (const m of meetings) {
      const t = titleOf(m);
      if (t && t.toLowerCase().includes(lower)) found.set(m.id, t);
    }
    const roles = new Map(meetings.map((m) => [m.id, (m.agenda_roles ?? {}) as Record<string, ItemRole>]));
    for (const r of await ctx.reader.noteItems(meetings.map((m) => m.id), likePattern(q))) {
      // The app's own rule: never a Må-runda row, an info cell or a line a human deleted.
      if (found.has(r.meeting_id) || !visible(r, roles.get(r.meeting_id) ?? {})) continue;
      found.set(r.meeting_id, r.text);
    }
    const privat = meetings.filter((m) => m.context_id).map((m) => m.id);
    for (const s of await ctx.reader.privateSummaries(privat, likePattern(q))) if (!found.has(s.meeting_id)) found.set(s.meeting_id, s.summary);
    hits = meetings.filter((m) => found.has(m.id)).map((m) => ({ m, snippet: snippet(found.get(m.id)!, q) }));
  }
  const { items, next_cursor } = page(hits, args.cursor, args.limit);
  return ok({
    meetings: items.map(({ m, snippet: s }) => {
      const space = spaceOf.get(m.org_id);
      return {
        meeting_id: m.id,
        org: space?.name ?? null,
        org_kind: space?.kind ?? null,
        ...(m.context_id ? { context_id: m.context_id } : {}),
        started_at: m.started_at,
        title: titleOf(m),
        ...(s ? { match: s } : {}),
      };
    }),
    next_cursor,
    ...(inRange.length === SEARCH_WINDOW ? { note: `Only the ${SEARCH_WINDOW} newest meetings in range were searched; narrow with from/to.` } : {}),
  });
}

export async function getMeeting(ctx: ToolCtx, args: { meeting_id: string }): Promise<ToolResult> {
  const id = args.meeting_id;
  const notFound = refuse("Meeting or recording not found, or you can't see it.");
  if (!isUuid(id)) return notFound;
  ctx.ids.meeting_id = id;
  const [m] = await ctx.reader.meetings({ ids: [id], done: false, limit: 1 });
  if (!m) return notFound;
  if (m.status !== "done" || m.is_test) return refuse("That meeting is not finished (or is a Testmöte); its notes are not final.");
  const org = (await ctx.reader.orgs()).find((o) => o.id === m.org_id);
  if (!org) return notFound;
  ctx.ids.org_id = org.id;
  const doc = m.doc_id ? docUrl(m.doc_id) : null;

  if (org.kind === "privat") {
    const [summary] = await ctx.reader.privateSummaries([id]);
    const context = m.context_id ? (await ctx.reader.contexts([org.id])).find((c) => c.id === m.context_id) : undefined;
    const tasks = m.context_id ? (await ctx.reader.contextTasks([m.context_id])).filter((t) => t.meeting_id === id) : [];
    return ok({
      meeting_id: id,
      org: org.name,
      org_kind: "privat",
      context_id: m.context_id ?? null,
      title: context?.name ?? null,
      started_at: m.started_at,
      attendance: summary?.people ?? [],
      summary: summary?.summary ?? null,
      decisions: summary?.decisions ?? [],
      tasks: tasks.map((t) => ({ task_id: `p:${t.id}`, text: t.text, owner: t.owner, done: t.done, can_complete: !t.done })),
      doc_url: doc,
    });
  }

  const [rows, people] = await Promise.all([ctx.reader.noteItems([id]), ctx.reader.people([org.id])]);
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  // 0068: where each decision and task was said, only when the user may read the transcript.
  const sourced = sorted.filter((r) => !r.deleted_by_human && (r.section === "decision" || r.section === "action") && r.source_segment_ids?.length).map((r) => r.id);
  const moments = sourced.length && ctx.reader.moments ? await ctx.reader.moments(id, sourced) : new Map<string, MomentLine[]>();
  const page = buildOrgMeeting({ userId: ctx.user.id, org: { id: org.id, name: org.name }, meeting: m, role: org.role, rows: sorted, people, moments });
  const said = (itemId: string) => {
    const lines = moments.get(itemId);
    const at = firstSourceMs(lines);
    return at === null ? { said_at: null, excerpt: null } : { said_at: formatSaidAt(at), excerpt: lines ? excerpt(lines) : null };
  };
  const roles = (m.agenda_roles ?? {}) as Record<string, ItemRole>;
  const attendance = sorted.filter((r) => r.section === "attendees" && visible(r, roles)).map((r) => clean(r.text));
  const other = summaryContent(sorted.filter((r) => r.section === "note"), { agendaRoles: roles });
  return ok({
    meeting_id: id,
    org: org.name,
    org_kind: org.kind,
    title: page.meeting.title,
    started_at: page.meeting.startedAt,
    attendance,
    decisions: (page.decisionItems ?? []).map((d) => ({ text: d.text, ...said(d.itemId) })),
    tasks: page.tasks.map((t) => ({
      task_id: t.key,
      text: t.text,
      owner: t.owner,
      due: t.due,
      due_date: t.dueDate,
      done_when: t.doneWhen,
      done: t.done,
      mine: t.mine,
      can_complete: t.canTick,
      ...said(t.itemId),
    })),
    summary: other.other.slice(0, MAX_SUMMARY_LINES),
    doc_url: page.docUrl,
  });
}

/** Mina uppgifter, as loadHome builds it (/hem), from the reader's rows. */
async function myTaskList(ctx: ToolCtx) {
  const orgs = await ctx.reader.orgs();
  const spaces: HomeSpace[] = orgs.map((o) => ({ id: o.id, name: o.name, kind: o.kind, isAdmin: o.role === "admin" }));
  const noteSpaces = spaces.filter((s) => s.kind === "forening" || s.kind === "foretag").map((s) => s.id);
  const privat = spaces.find((s) => s.kind === "privat") ?? null;
  const meetings: McpMeeting[] = [];
  for (const org of noteSpaces) meetings.push(...(await ctx.reader.meetings({ org, done: true, limit: MEETINGS_PER_SPACE })));
  const [rows, people, handoffs] = await Promise.all([
    ctx.reader.noteItems(meetings.map((m) => m.id)),
    ctx.reader.people(noteSpaces),
    // Reviewed tasks: a Företag, or a förening with groups (0054), as /hem reads them.
    ctx.reader.handoffs(noteSpaces),
  ]);
  let privatTasks: ReturnType<typeof myPrivatTasks> = [];
  if (privat) {
    const contexts = await ctx.reader.contexts([privat.id]);
    const tasks = await ctx.reader.contextTasks(contexts.map((c) => c.id));
    const starts = tasks.length ? await ctx.reader.meetings({ org: privat.id, done: false, limit: 1000 }) : [];
    privatTasks = myPrivatTasks({ space: privat, tasks, contexts, meetings: starts });
  }
  return sortTasks([
    ...myForeningTasks({ userId: ctx.user.id, spaces, meetings, rows: rows.filter((r) => r.section === "action" || r.section === "decision") as HomeNoteRow[], people }),
    ...myHandoffTasks({ userId: ctx.user.id, spaces, handoffs, people }),
    ...privatTasks,
  ]);
}

export async function myTasks(
  ctx: ToolCtx,
  args: { status?: "open" | "done" | "all"; due_before?: string; cursor?: string; limit?: number },
): Promise<ToolResult> {
  const status = args.status ?? "open";
  const tasks = (await myTaskList(ctx)).filter(
    (t) => (status === "all" || (status === "done") === t.done) && (!args.due_before || (t.dueDate !== null && t.dueDate < args.due_before)),
  );
  const { items, next_cursor } = page(tasks, args.cursor, args.limit);
  return ok({
    tasks: items.map((t) => ({
      task_id: t.key,
      text: t.text,
      org: t.spaceName,
      org_kind: t.spaceKind,
      due: t.due,
      due_date: t.dueDate,
      done_when: t.doneWhen,
      done: t.done,
      // A reviewed Företag task never names its meeting (the owner may not see it).
      ...(t.kind === "handoff" ? { from: t.fromName ?? null } : { meeting_id: t.meetingId, meeting_at: t.meetingAt }),
      ...(t.contextName ? { context: t.contextName } : {}),
    })),
    next_cursor,
  });
}

/** `n:<meeting>:<item>`, `p:<task>` or `h:<handoff>` (MyTask.key). */
export function parseTaskId(taskId: string): { kind: "note"; meetingId: string; itemId: string } | { kind: "privat" | "handoff"; id: string } | null {
  const n = /^n:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,64})$/i.exec(taskId);
  if (n && isUuid(n[1])) return { kind: "note", meetingId: n[1], itemId: n[2] };
  const p = /^([ph]):([0-9a-f-]{36})$/i.exec(taskId);
  if (p && isUuid(p[2])) return { kind: p[1] === "p" ? "privat" : "handoff", id: p[2] };
  return null;
}

export async function completeTask(ctx: ToolCtx, args: { task_id: string }): Promise<ToolResult> {
  const parsed = parseTaskId(args.task_id);
  if (!parsed) return refuse("Unknown task_id. Use a task_id from my_tasks or get_meeting.");
  ctx.ids.task_id = args.task_id;
  if (parsed.kind !== "note") {
    // A reviewed Företag task: only its owner (set_task_handoff_done); no Doc is touched.
    if (parsed.kind === "handoff") {
      return (await ctx.reader.setHandoffDone(parsed.id, true)) ? ok({ done: true, doc: "none" }) : refuse("You can't complete that task (not yours, or not found).");
    }
    return (await ctx.reader.setPrivatTaskDone(parsed.id, true)) ? ok({ done: true, doc: "none" }) : refuse("Task not found, or you can't see it.");
  }
  ctx.ids.meeting_id = parsed.meetingId;
  // The meeting must be one the user sees (actorFor re-checks); then the app's own path decides (owner or admin).
  const db = await actorFor(ctx, { meetingId: parsed.meetingId });
  if (!db) return refuse("Task not found, or you can't see it.");
  const result = await ctx.deps.completeNoteTask(db, ctx.user.id, parsed.meetingId, parsed.itemId);
  if (!result.ok) {
    if (result.error === "forbidden") return refuse("Only the task's owner or an admin of the förening can complete it.");
    if (result.error === "not_open") return refuse("That meeting is not finished yet; tasks are completed after it ends.");
    return refuse("Task not found, or you can't see it.");
  }
  const docNote: Record<string, string> = {
    written: "Marked ✓ klart in the meeting's Google Doc too.",
    locked: "Done in Simon Says. Someone edited that line in the Doc, so it was left alone: tick it there too if you want.",
    failed: "Done in Simon Says, but the Google Doc could not be updated right now.",
    none: "Done.",
  };
  return ok({ done: true, doc: result.doc, note: docNote[result.doc] });
}

export async function prepareAgenda(ctx: ToolCtx, args: { org_id?: string; meeting_id?: string; point: string }): Promise<ToolResult> {
  const point = clean(args.point);
  if (point.length < 1 || point.length > 120) return refuse("point must be 1 to 120 characters.");
  let orgId = args.org_id ?? null;
  if (!orgId && args.meeting_id) {
    if (!isUuid(args.meeting_id)) return refuse("Meeting not found, or you can't see it.");
    ctx.ids.meeting_id = args.meeting_id;
    const [m] = await ctx.reader.meetings({ ids: [args.meeting_id], done: false, limit: 1 });
    if (!m) return refuse("Meeting not found, or you can't see it.");
    orgId = m.org_id;
  }
  if (!orgId || !isUuid(orgId)) return refuse("Give org_id (from list_spaces) or meeting_id.");
  ctx.ids.org_id = orgId;
  const org = (await ctx.reader.orgs()).find((o) => o.id === orgId);
  if (!org) return refuse("Unknown org_id (or you are not a member).");
  // Förbered möte is förening only (lib/foretag/guard.ts; proxy.ts for Privat).
  if (org.kind !== "forening") return refuse("Agendas are prepared only for a förening's meetings (not a Företag, and not Privat recordings).");

  // A member of this förening (shown by the reader): Förbered möte's own path, with this user as actor.
  const db = await actorFor(ctx, { foreningId: orgId });
  if (!db) return refuse("Unknown org_id (or you are not a member).");
  const [next] = await ctx.deps.upcomingPrepared(db, orgId, localDate(ctx.now));
  let when: { type: "veckomote" | "styrelsemote" | "arsmote"; date: string; time: string | null };
  if (next) {
    ctx.ids.prepared_id = next.id;
    when = { type: next.kind, date: next.meeting_date, time: next.meeting_time ?? null };
  } else {
    // No agenda yet: the next meeting as Förbered möte proposes it (last meeting's weekday and time).
    const [last] = await ctx.reader.meetings({ org: orgId, done: true, limit: 1 });
    const proposed = proposedWhen(ctx.now, last?.started_at ?? null);
    when = { type: "veckomote", date: proposed.date, time: proposed.time || null };
  }
  const draft = await ctx.deps.loadDraft(db, orgId, when.type, when.date, ctx.now);
  if (!draft.ok) return refuse(draft.message);
  const items = draft.draft.items;
  if (items.some((i) => i.on && clean(i.label).toLowerCase() === point.toLowerCase())) {
    return ok({ added: false, note: "That point is already on the agenda.", date: when.date, doc_url: draft.draft.existing?.docUrl ?? null });
  }
  const withPoint = addItem(items, point, `add:mcp${Date.now().toString(36)}`);
  const saved = await ctx.deps.savePrepared(
    db,
    { id: ctx.user.id, email: ctx.user.email },
    orgId,
    { type: draft.draft.type, date: when.date, time: draft.draft.time ?? when.time, items: bodyItems(withPoint) },
    ctx.now,
  );
  if (!saved.ok) return refuse(saved.message);
  return ok({ added: true, created: saved.created, date: saved.date, agenda: saved.docName, doc_url: saved.docUrl });
}
