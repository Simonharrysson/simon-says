import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { visible, stockholmDay } from "@/lib/home/tasks";
import { oneShot, type OneShotInput, type OneShotResult } from "@/lib/notes/oneshot";
import { summaryContent } from "@/lib/summaries/content";
import {
  applyEdits,
  clean,
  GENERATED_JSON_SCHEMA,
  GeneratedSchema,
  MEMORY_COOLDOWN_S,
  MEMORY_MEETINGS,
  mergeGenerated,
  newLineId,
  parseLines,
  type EditedLine,
  type Generated,
  type MemoryLine,
} from "./memory";
import { MEMORY_SYSTEM_PROMPT, memoryUserText, type MemoryMeeting } from "./prompt";

// "Vad Claude ska veta": the page's reads and writes. The page and the edits use the admin's own
// client (org_memory RLS: members read, admins write). Uppdatera picks its meetings with
// org_memory_sources (service role: meetings EVERY member can see, 0065), reads their rows with the
// service role, keeps only what the app shows (visible(), summaryContent) and writes the result
// with the admin's client again.

export interface OrgMemory {
  lines: MemoryLine[];
  generatedAt: string | null;
  sourcesFrom: string | null;
  sourcesCount: number;
  updatedAt: string | null;
}

export const EMPTY_MEMORY: OrgMemory = { lines: [], generatedAt: null, sourcesFrom: null, sourcesCount: 0, updatedAt: null };

const missingTable = (e: { code?: string; message: string }) => e.code === "42P01" || e.code === "PGRST205";

type Row = { lines: unknown; generated_at: string | null; sources_from: string | null; sources_count: number | null; updated_at: string | null };

export const toMemory = (r: Row | null | undefined): OrgMemory =>
  r
    ? { lines: parseLines(r.lines), generatedAt: r.generated_at, sourcesFrom: r.sources_from, sourcesCount: r.sources_count ?? 0, updatedAt: r.updated_at }
    : EMPTY_MEMORY;

/** The org's page as `db`'s user may read it (members: RLS). */
export async function loadMemory(db: SupabaseClient, orgId: string): Promise<OrgMemory> {
  const { data, error } = await db.from("org_memory").select("lines, generated_at, sources_from, sources_count, updated_at").eq("org_id", orgId).maybeSingle();
  if (error) {
    if (missingTable(error)) return EMPTY_MEMORY;
    throw new Error(`org_memory: ${error.message}`);
  }
  return toMemory(data as Row | null);
}

export interface SourceMeeting {
  id: string;
  date: string;
  title: string | null;
}

/** The source meetings `db`'s user can see (RLS), for the links under each line. */
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

async function write(db: SupabaseClient, orgId: string, userId: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await db
    .from("org_memory")
    .upsert({ org_id: orgId, ...patch, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "org_id" });
  if (error) {
    console.error(`org_memory: write failed: ${error.message}`);
    return false;
  }
  return true;
}

/** An admin's edits (RLS: admins only). False when invalid or not saved. */
export async function saveMemoryEdits(db: SupabaseClient, orgId: string, userId: string, edits: EditedLine[]): Promise<boolean> {
  const current = await loadMemory(db, orgId);
  const lines = applyEdits(current.lines, edits, newLineId);
  if (!lines) return false;
  return write(db, orgId, userId, { lines });
}

export type RefreshResult = { ok: true; lines: number; meetings: number } | { ok: false; reason: "cooldown" | "empty" | "spend" | "failed" };

export interface RefreshDeps {
  /** The service-role client (org_memory_sources and the source rows). */
  admin: SupabaseClient;
  oneShot: <T>(input: OneShotInput<T>) => Promise<OneShotResult<T>>;
  now: Date;
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
 * Lines an admin wrote or changed are kept and shown to Claude; the generated ones are replaced.
 */
export async function refreshMemory(db: SupabaseClient, org: { id: string; name: string }, userId: string, deps: RefreshDeps): Promise<RefreshResult> {
  const current = await loadMemory(db, org.id);
  if (current.generatedAt && deps.now.getTime() - new Date(current.generatedAt).getTime() < MEMORY_COOLDOWN_S * 1000) return { ok: false, reason: "cooldown" };
  const meetings = await draftMeetings(deps.admin, org.id);
  if (!meetings.length) return { ok: false, reason: "empty" };
  const kept = current.lines.filter((l) => l.edited);
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
  const lines = mergeGenerated(current.lines, result.value, new Set(meetings.map((m) => m.id)), newLineId);
  const oldest = meetings.at(-1)!;
  const saved = await write(db, org.id, userId, {
    lines,
    generated_at: deps.now.toISOString(),
    sources_from: `${oldest.date}T00:00:00Z`,
    sources_count: meetings.length,
  });
  return saved ? { ok: true, lines: lines.length, meetings: meetings.length } : { ok: false, reason: "failed" };
}

export const defaultOneShot = oneShot;
