import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { visible, stockholmDay } from "@/lib/home/tasks";
import { oneShot, type OneShotInput, type OneShotResult } from "@/lib/notes/oneshot";
import { summaryContent } from "@/lib/summaries/content";
import {
  allSources,
  applyEdits,
  clean,
  GENERATED_JSON_SCHEMA,
  GeneratedSchema,
  MEMORY_COOLDOWN_S,
  MAX_LINES,
  MEMORY_MEETINGS,
  mergeGenerated,
  newLineId,
  parseLines,
  type EditedLine,
  type Generated,
  type MemoryLine,
  visibleLines,
} from "./memory";
import { MEMORY_SYSTEM_PROMPT, memoryUserText, type MemoryMeeting } from "./prompt";

// "Vad Claude ska veta": the page's reads and writes, all on the server (0065 gives clients no
// access to org_memory). Reads go through the service role after the admin check and keep only the
// lines whose every source the reader can still see (their own client, meetings RLS): a meeting
// that later turns private or moves into a group never leaks through a line, for admins too.
// Writes are optimistic ("where version = <read>", retried on a conflict and merged again, so an
// admin's edit is never overwritten); Uppdatera claims its cooldown atomically before calling
// Claude. Its meetings come from org_memory_sources (meetings EVERY member can see), with only what
// the app shows of them (visible(), summaryContent).

export interface OrgMemory {
  lines: MemoryLine[];
  generatedAt: string | null;
  sourcesFrom: string | null;
  sourcesCount: number;
  updatedAt: string | null;
}

export const EMPTY_MEMORY: OrgMemory = { lines: [], generatedAt: null, sourcesFrom: null, sourcesCount: 0, updatedAt: null };

const missingTable = (e: { code?: string; message: string }) => e.code === "42P01" || e.code === "PGRST205";

type Row = { lines: unknown; generated_at: string | null; sources_from: string | null; sources_count: number | null; updated_at: string | null; version?: number | null };

export const toMemory = (r: Row | null | undefined): OrgMemory =>
  r
    ? { lines: parseLines(r.lines), generatedAt: r.generated_at, sourcesFrom: r.sources_from, sourcesCount: r.sources_count ?? 0, updatedAt: r.updated_at }
    : EMPTY_MEMORY;

/** The stored page and its version (service role), or null when there is none yet. */
async function readRow(admin: SupabaseClient, orgId: string): Promise<{ memory: OrgMemory; version: number } | null> {
  const { data, error } = await admin.from("org_memory").select("lines, generated_at, sources_from, sources_count, updated_at, version").eq("org_id", orgId).maybeSingle();
  if (error) {
    if (missingTable(error)) return null;
    throw new Error(`org_memory: ${error.message}`);
  }
  return data ? { memory: toMemory(data as Row), version: (data as Row).version ?? 0 } : null;
}

export interface SourceMeeting {
  id: string;
  date: string;
  title: string | null;
}

/** The source meetings `db`'s user can see (RLS), for the links under each line and the read filter. */
export async function sourceMeetings(db: SupabaseClient, ids: string[]): Promise<Record<string, SourceMeeting>> {
  const out: Record<string, SourceMeeting> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from("meetings").select("id, started_at, title").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`memory sources: ${error.message}`);
    for (const m of (data ?? []) as { id: string; started_at: string; title?: string | null }[]) {
      out[m.id] = { id: m.id, date: stockholmDay(m.started_at), title: clean(m.title) || null };
    }
  }
  return out;
}

/** Is `userId` an admin of this förening or Företag (read as them: RLS), never Privat. */
async function isAdminOf(db: SupabaseClient, orgId: string, userId: string): Promise<boolean> {
  const [{ data: m }, { data: o }] = await Promise.all([
    db.from("org_members").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle(),
    db.from("orgs").select("kind").eq("id", orgId).maybeSingle(),
  ]);
  return m?.role === "admin" && Boolean(o) && o!.kind !== "privat";
}

/** The lines `db`'s user may see: each source still visible to them (none: an admin's own line). */
async function filterFor(db: SupabaseClient, lines: MemoryLine[]) {
  const sources = await sourceMeetings(db, allSources(lines));
  return { lines: visibleLines(lines, new Set(Object.keys(sources))), sources };
}

/** The page for an admin (null for anyone else): only the lines whose every source they can see. */
export async function loadMemoryFor(db: SupabaseClient, admin: SupabaseClient, orgId: string, userId: string): Promise<{ memory: OrgMemory; sources: Record<string, SourceMeeting> } | null> {
  if (!(await isAdminOf(db, orgId, userId))) return null;
  const row = await readRow(admin, orgId);
  if (!row) return { memory: EMPTY_MEMORY, sources: {} };
  const { lines, sources } = await filterFor(db, row.memory.lines);
  return { memory: { ...row.memory, lines }, sources };
}

const RETRIES = 3;

/**
 * One write "where version = `version`" (null: the row doesn't exist yet, so insert). False on a
 * conflict (someone wrote in between): the caller reads again and merges.
 */
async function writeIfUnchanged(admin: SupabaseClient, orgId: string, userId: string, version: number | null, patch: Record<string, unknown>): Promise<boolean> {
  const body = { ...patch, updated_at: new Date().toISOString(), updated_by: userId };
  if (version === null) {
    const { error } = await admin.from("org_memory").insert({ org_id: orgId, ...body, version: 1 });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw new Error(`org_memory: insert: ${error.message}`);
  }
  const { data, error } = await admin.from("org_memory").update({ ...body, version: version + 1 }).eq("org_id", orgId).eq("version", version).select("org_id");
  if (error) throw new Error(`org_memory: update: ${error.message}`);
  return (data ?? []).length === 1;
}

/**
 * An admin's save. `seenIds`: the lines their page showed. Only those are edited or removed; every
 * other line (one they can't see, or one Uppdatera wrote meanwhile) stays as it is. False when
 * not an admin, invalid, or not saved.
 */
export async function saveMemoryEdits(db: SupabaseClient, admin: SupabaseClient, orgId: string, userId: string, edits: EditedLine[], seenIds: string[]): Promise<boolean> {
  if (!(await isAdminOf(db, orgId, userId)) || !Array.isArray(seenIds)) return false;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const row = await readRow(admin, orgId);
    const all = row?.memory.lines ?? [];
    // Only lines this admin may see now count as seen (a forged id can't touch a hidden line).
    const visibleIds = new Set((await filterFor(db, all)).lines.map((l) => l.id));
    const seen = new Set(seenIds.filter((id) => typeof id === "string" && visibleIds.has(id)));
    const edited = applyEdits(all.filter((l) => seen.has(l.id)), edits, newLineId);
    if (!edited) return false;
    const lines = [...edited, ...all.filter((l) => !seen.has(l.id))].slice(0, MAX_LINES);
    if (await writeIfUnchanged(admin, orgId, userId, row ? row.version : null, { lines })) return true;
  }
  console.error("org_memory: save gave up after conflicts");
  return false;
}

export type RefreshResult = { ok: true; lines: number; meetings: number } | { ok: false; reason: "forbidden" | "cooldown" | "empty" | "spend" | "failed" };

export interface RefreshDeps {
  /** The service-role client (org_memory_sources and the source rows). */
  admin: SupabaseClient;
  oneShot: <T>(input: OneShotInput<T>) => Promise<OneShotResult<T>>;
  now: Date;
}

/**
 * Take this org's Uppdatera slot: one conditional update (generated_at empty or older than the
 * cooldown), so two refreshes at once can't both run. False: in cooldown.
 */
export async function claimRefresh(admin: SupabaseClient, orgId: string, userId: string, now: Date): Promise<boolean> {
  const { error: e1 } = await admin.from("org_memory").upsert({ org_id: orgId, updated_by: userId }, { onConflict: "org_id", ignoreDuplicates: true });
  if (e1) throw new Error(`org_memory: claim row: ${e1.message}`);
  const before = new Date(now.getTime() - MEMORY_COOLDOWN_S * 1000).toISOString();
  const { data, error } = await admin
    .from("org_memory")
    .update({ generated_at: now.toISOString() })
    .eq("org_id", orgId)
    .or(`generated_at.is.null,generated_at.lt.${before}`)
    .select("org_id");
  if (error) throw new Error(`org_memory: claim: ${error.message}`);
  return (data ?? []).length === 1;
}

/** The meetings for a draft and what the app shows of each (visible(), summaryContent's lists). */
export async function draftMeetings(admin: SupabaseClient, orgId: string, limit = MEMORY_MEETINGS): Promise<MemoryMeeting[]> {
  const { data: meetings, error } = await admin.rpc("org_memory_sources", { p_org: orgId, p_limit: limit });
  if (error) throw new Error(`org_memory_sources: ${error.message}`);
  const list = (meetings ?? []) as { id: string; started_at: string; title?: string | null; agenda_roles?: Record<string, ItemRole> | null }[];
  const rows: NoteItemRow[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error: e2 } = await admin.from("note_items").select("*").in("meeting_id", list.slice(i, i + 100).map((m) => m.id));
    if (e2) throw new Error(`memory rows: ${e2.message}`);
    rows.push(...((data ?? []) as NoteItemRow[]));
  }
  return list.map((m) => {
    const roles = (m.agenda_roles ?? {}) as Record<string, ItemRole>;
    const mine = rows.filter((r) => r.meeting_id === m.id);
    const content = summaryContent(mine, { agendaRoles: roles });
    const attendees = mine.filter((r) => r.section === "attendees" && visible(r, roles)).map((r) => clean(r.text));
    return { id: m.id, date: stockholmDay(m.started_at), title: clean(m.title) || null, attendees, content };
  });
}

/**
 * Uppdatera (an admin, `db` their client): a new draft from the meetings every member can see.
 * Lines an admin wrote or changed are kept (and shown to Claude when their sources are among the
 * meetings it gets); the generated ones are replaced. The result is merged into the page as it is
 * when written, so an edit made while Claude was working is kept too.
 */
export async function refreshMemory(db: SupabaseClient, org: { id: string; name: string }, userId: string, deps: RefreshDeps): Promise<RefreshResult> {
  if (!(await isAdminOf(db, org.id, userId))) return { ok: false, reason: "forbidden" };
  if (!(await claimRefresh(deps.admin, org.id, userId, deps.now))) return { ok: false, reason: "cooldown" };
  const meetings = await draftMeetings(deps.admin, org.id);
  if (!meetings.length) return { ok: false, reason: "empty" };
  const allowed = new Set(meetings.map((m) => m.id));
  const before = (await readRow(deps.admin, org.id))?.memory.lines ?? [];
  const kept = before.filter((l) => l.edited && l.sources.every((s) => allowed.has(s)));
  const result = await deps.oneShot<Generated>({
    label: "org memory",
    system: MEMORY_SYSTEM_PROMPT,
    user: memoryUserText({ orgName: org.name, kept, meetings }),
    jsonSchema: GENERATED_JSON_SCHEMA as unknown as Record<string, unknown>,
    schema: GeneratedSchema,
    maxTokens: 8000,
    orgId: org.id,
    timeoutMs: 90_000,
  });
  if (!result.ok) return { ok: false, reason: result.reason === "spend" ? "spend" : "failed" };
  const oldest = meetings.at(-1)!;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const row = await readRow(deps.admin, org.id);
    const lines = mergeGenerated(row?.memory.lines ?? [], result.value, allowed, newLineId);
    const saved = await writeIfUnchanged(deps.admin, org.id, userId, row ? row.version : null, {
      lines,
      generated_at: deps.now.toISOString(),
      sources_from: `${oldest.date}T00:00:00Z`,
      sources_count: meetings.length,
    });
    if (saved) return { ok: true, lines: lines.length, meetings: meetings.length };
  }
  console.error("org_memory: refresh gave up after conflicts");
  return { ok: false, reason: "failed" };
}

export const defaultOneShot = oneShot;
