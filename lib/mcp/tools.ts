import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ItemRole } from "@/lib/db/types";
import { isUuid } from "@/lib/db/ids";
import { setHandoffDone } from "@/lib/db/foretag";
import { localDate } from "@/lib/docs/create";
import { completeNoteTask, setPrivatTaskDone } from "@/lib/home/complete";
import { loadHome } from "@/lib/home/load";
import { loadOrgMeeting } from "@/lib/home/meeting";
import { visible, type HomeNoteRow } from "@/lib/home/tasks";
import { loadMeetingPage } from "@/lib/privat/load";
import { bodyItems, addItem } from "@/lib/prepare/edit";
import { loadDraft, savePrepared } from "@/lib/prepare/prepare";
import { upcomingPrepared } from "@/lib/prepare/store";
import { summaryContent } from "@/lib/summaries/content";
import { docUrl } from "@/lib/ui/meetings";

// The MCP tools (docs/superpowers/specs/2026-11-27-mcp-design.md "Tools v1"). Every one runs on
// the user's own client (`ctx.db`, RLS) and reuses the app's loaders, so a tool never shows more
// than the app shows that user. Results are compact JSON; lists are paginated. The ids each call
// touched go to the audit log (`ctx.ids`), never any text.

export interface ToolDeps {
  loadHome: typeof loadHome;
  loadOrgMeeting: typeof loadOrgMeeting;
  loadMeetingPage: typeof loadMeetingPage;
  completeNoteTask: typeof completeNoteTask;
  setPrivatTaskDone: typeof setPrivatTaskDone;
  setHandoffDone: typeof setHandoffDone;
  upcomingPrepared: typeof upcomingPrepared;
  loadDraft: typeof loadDraft;
  savePrepared: typeof savePrepared;
}

export const defaultToolDeps: ToolDeps = {
  loadHome,
  loadOrgMeeting,
  loadMeetingPage,
  completeNoteTask,
  setPrivatTaskDone,
  setHandoffDone,
  upcomingPrepared,
  loadDraft,
  savePrepared,
};

export interface ToolCtx {
  db: SupabaseClient;
  user: User;
  deps: ToolDeps;
  now: Date;
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
const SNIPPET = 160;
const MAX_SUMMARY_LINES = 8;

const clean = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
const fail = (what: string, error: { message: string }): never => {
  throw new Error(`mcp tool: ${what}: ${error.message}`);
};

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

type SpaceKind = "forening" | "foretag" | "privat";
interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  role: "admin" | "member";
}

async function mySpaces(ctx: ToolCtx): Promise<Space[]> {
  const { data: members, error } = await ctx.db.from("org_members").select("org_id, role").eq("user_id", ctx.user.id);
  if (error) fail("members", error);
  const roleOf = new Map((members ?? []).map((m) => [m.org_id as string, m.role as Space["role"]]));
  if (!roleOf.size) return [];
  const { data: orgs, error: e2 } = await ctx.db.from("orgs").select("id, name, kind").in("id", [...roleOf.keys()]);
  if (e2) fail("orgs", e2);
  return ((orgs ?? []) as { id: string; name: string; kind: string }[])
    .map((o) => ({
      id: o.id,
      name: o.name,
      kind: (o.kind === "privat" || o.kind === "foretag" ? o.kind : "forening") as SpaceKind,
      role: roleOf.get(o.id) ?? "member",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

// ---------------------------------------------------------------------------------------------

export async function listOrgs(ctx: ToolCtx): Promise<ToolResult> {
  const spaces = await mySpaces(ctx);
  return ok({ orgs: spaces.map((s) => ({ org_id: s.id, name: s.name, kind: s.kind, role: s.role })) });
}

interface MeetingLite {
  id: string;
  org_id: string;
  started_at: string;
  title: string | null;
  context_id: string | null;
  agenda_roles: Record<string, ItemRole> | null;
}

export async function searchMeetings(
  ctx: ToolCtx,
  args: { query?: string; org_id?: string; from?: string; to?: string; cursor?: string; limit?: number },
): Promise<ToolResult> {
  const spaces = await mySpaces(ctx);
  if (args.org_id) ctx.ids.org_id = args.org_id;
  const inScope = args.org_id ? spaces.filter((s) => s.id === args.org_id) : spaces;
  if (args.org_id && !inScope.length) return refuse("Unknown org_id (or you are not a member). Call list_orgs for your orgs.");
  if (!inScope.length) return ok({ meetings: [], next_cursor: null });
  const q = clean(args.query);
  if (q && (q.length < 2 || q.length > 100)) return refuse("query must be 2 to 100 characters.");

  let query = ctx.db
    .from("meetings")
    .select("id, org_id, started_at, title, context_id, agenda_roles")
    .in("org_id", inScope.map((s) => s.id))
    .eq("status", "done")
    .eq("is_test", false)
    .order("started_at", { ascending: false })
    .limit(SEARCH_WINDOW);
  if (args.from) query = query.gte("started_at", `${args.from}T00:00:00Z`);
  if (args.to) query = query.lte("started_at", `${args.to}T23:59:59Z`);
  const { data, error } = await query;
  if (error) fail("meetings", error);
  const meetings = (data ?? []) as MeetingLite[];
  const spaceOf = new Map(spaces.map((s) => [s.id, s]));

  // Privat recordings are titled by their context ("TDDE15").
  const privatIds = inScope.filter((s) => s.kind === "privat").map((s) => s.id);
  const contextName = new Map<string, string>();
  if (privatIds.length) {
    const { data: ctxs, error: e } = await ctx.db.from("contexts").select("id, name").in("org_id", privatIds);
    if (e) fail("contexts", e);
    for (const c of ctxs ?? []) contextName.set(c.id as string, c.name as string);
  }
  const titleOf = (m: MeetingLite) => clean(m.title) || (m.context_id ? (contextName.get(m.context_id) ?? null) : null);

  let hits: { m: MeetingLite; snippet: string | null }[];
  if (!q) {
    hits = meetings.map((m) => ({ m, snippet: null }));
  } else {
    const found = new Map<string, string>();
    const lower = q.toLowerCase();
    for (const m of meetings) {
      const t = titleOf(m);
      if (t && t.toLowerCase().includes(lower)) found.set(m.id, t);
    }
    const ids = meetings.map((m) => m.id);
    const roles = new Map(meetings.map((m) => [m.id, (m.agenda_roles ?? {}) as Record<string, ItemRole>]));
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const { data: rows, error: e } = await ctx.db.from("note_items").select("*").in("meeting_id", part).ilike("text", likePattern(q)).limit(1000);
      if (e) fail("note_items", e);
      for (const r of (rows ?? []) as HomeNoteRow[]) {
        // The app's own rule: never a Må-runda row, an info cell or a line a human deleted.
        if (found.has(r.meeting_id) || !visible(r, roles.get(r.meeting_id) ?? {})) continue;
        found.set(r.meeting_id, r.text);
      }
      const privatPart = part.filter((id) => meetings.find((m) => m.id === id)?.context_id);
      if (privatPart.length) {
        const { data: sums, error: e2 } = await ctx.db.from("private_summaries").select("meeting_id, summary").in("meeting_id", privatPart).ilike("summary", likePattern(q));
        if (e2) fail("private_summaries", e2);
        for (const s of sums ?? []) if (!found.has(s.meeting_id as string)) found.set(s.meeting_id as string, s.summary as string);
      }
    }
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
        started_at: m.started_at,
        title: titleOf(m),
        ...(s ? { match: s } : {}),
      };
    }),
    next_cursor,
    ...(meetings.length === SEARCH_WINDOW ? { note: `Only the ${SEARCH_WINDOW} newest meetings in range were searched; narrow with from/to.` } : {}),
  });
}

export async function getMeeting(ctx: ToolCtx, args: { meeting_id: string }): Promise<ToolResult> {
  const id = args.meeting_id;
  const notFound = refuse("Meeting not found, or you can't see it.");
  if (!isUuid(id)) return notFound;
  ctx.ids.meeting_id = id;
  const { data: meeting, error } = await ctx.db.from("meetings").select("id, org_id, status, is_test, agenda_roles").eq("id", id).maybeSingle();
  if (error) fail("meeting", error);
  if (!meeting) return notFound;
  if (meeting.status !== "done" || meeting.is_test) return refuse("That meeting is not finished (or is a Testmöte); its notes are not final.");
  const { data: org, error: e2 } = await ctx.db.from("orgs").select("id, name, kind").eq("id", meeting.org_id).maybeSingle();
  if (e2) fail("org", e2);
  if (!org) return notFound;
  ctx.ids.org_id = org.id as string;

  if (org.kind === "privat") {
    const p = await ctx.deps.loadMeetingPage(ctx.db, id);
    if (!p) return notFound;
    return ok({
      meeting_id: id,
      org: org.name,
      org_kind: "privat",
      title: p.context?.name ?? null,
      started_at: p.meeting.started_at,
      attendance: p.summary?.people ?? [],
      summary: p.summary?.summary ?? null,
      decisions: p.summary?.decisions ?? [],
      tasks: p.tasks.map((t) => ({ task_id: `p:${t.id}`, text: t.text, owner: t.owner, done: t.done, can_complete: !t.done })),
      doc_url: p.meeting.doc_id ? docUrl(p.meeting.doc_id) : null,
    });
  }

  const page = await ctx.deps.loadOrgMeeting(ctx.db, ctx.user.id, org.id as string, id);
  if (!page) return notFound;
  const { data: rows, error: e3 } = await ctx.db.from("note_items").select("*").eq("meeting_id", id).in("section", ["attendees", "note"]).order("position");
  if (e3) fail("notes", e3);
  const roles = (meeting.agenda_roles ?? {}) as Record<string, ItemRole>;
  const notes = (rows ?? []) as HomeNoteRow[];
  const attendance = notes.filter((r) => r.section === "attendees" && visible(r, roles)).map((r) => clean(r.text));
  const other = summaryContent(notes.filter((r) => r.section === "note"), { agendaRoles: roles });
  return ok({
    meeting_id: id,
    org: page.org.name,
    org_kind: org.kind === "foretag" ? "foretag" : "forening",
    title: page.meeting.title,
    started_at: page.meeting.startedAt,
    attendance,
    decisions: page.decisions,
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
    })),
    summary: other.other.slice(0, MAX_SUMMARY_LINES),
    doc_url: page.docUrl,
  });
}

export async function myTasks(
  ctx: ToolCtx,
  args: { status?: "open" | "done" | "all"; due_before?: string; cursor?: string; limit?: number },
): Promise<ToolResult> {
  const home = await ctx.deps.loadHome(ctx.db, ctx.user.id);
  const status = args.status ?? "open";
  const tasks = home.tasks.filter(
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
  if (parsed.kind === "handoff") {
    // A reviewed Företag task: only its owner; no Doc is touched (they can't see it).
    const done = await ctx.deps.setHandoffDone(ctx.db, parsed.id, true);
    return done ? ok({ done: true, doc: "none" }) : refuse("You can't complete that task (not yours, or not found).");
  }
  if (parsed.kind === "note") ctx.ids.meeting_id = parsed.meetingId;
  const result =
    parsed.kind === "note"
      ? await ctx.deps.completeNoteTask(ctx.db, ctx.user.id, parsed.meetingId, parsed.itemId)
      : await ctx.deps.setPrivatTaskDone(ctx.db, parsed.id, true);
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
    const { data, error } = await ctx.db.from("meetings").select("org_id").eq("id", args.meeting_id).maybeSingle();
    if (error) fail("meeting", error);
    if (!data) return refuse("Meeting not found, or you can't see it.");
    orgId = data.org_id as string;
  }
  if (!orgId || !isUuid(orgId)) return refuse("Give org_id (from list_orgs) or meeting_id.");
  ctx.ids.org_id = orgId;
  const { data: org, error } = await ctx.db.from("orgs").select("id, kind").eq("id", orgId).maybeSingle();
  if (error) fail("org", error);
  if (!org) return refuse("Unknown org_id (or you are not a member).");
  // Förbered möte is förening only (lib/foretag/guard.ts; proxy.ts for Privat).
  if (org.kind !== "forening") return refuse("Agendas are prepared only in a förening (not a Företag or Privat).");

  const [next] = await ctx.deps.upcomingPrepared(ctx.db, orgId, localDate(ctx.now));
  if (!next) {
    return refuse("No agenda is prepared for an upcoming meeting yet. Open Förbered möte in Simon Says to create one; then points can be added here.");
  }
  ctx.ids.prepared_id = next.id;
  const draft = await ctx.deps.loadDraft(ctx.db, orgId, next.kind, next.meeting_date, ctx.now);
  if (!draft.ok) return refuse(draft.message);
  const items = draft.draft.items;
  if (items.some((i) => i.on && clean(i.label).toLowerCase() === point.toLowerCase())) {
    return ok({ added: false, note: "That point is already on the agenda.", date: next.meeting_date, doc_url: docUrl(next.doc_id) });
  }
  const withPoint = addItem(items, point, `add:mcp${Date.now().toString(36)}`);
  const saved = await ctx.deps.savePrepared(
    ctx.db,
    { id: ctx.user.id, email: ctx.user.email },
    orgId,
    { type: draft.draft.type, date: next.meeting_date, time: next.meeting_time ?? null, items: bodyItems(withPoint) },
    ctx.now,
  );
  if (!saved.ok) return refuse(saved.message);
  return ok({ added: true, date: saved.date, agenda: saved.docName, doc_url: saved.docUrl });
}
