import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteItemRow } from "@/lib/db/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { DocLine, Journal } from "./doc";
import type { DraftItem, MeetingType } from "./draft";

// prepared_agendas (0033): one prepared agenda per förening and meeting date. Written by the
// service role (the routes check membership first); read with either client. A database without
// 0033 (deploy order) reads as "nothing prepared", never as an error.

export interface PreparedAgenda {
  id: string;
  org_id: string;
  /** `YYYY-MM-DD`. */
  meeting_date: string;
  /** `HH:MM` or null. */
  meeting_time: string | null;
  kind: MeetingType;
  format_profile_id: string | null;
  doc_id: string;
  tab_id: string;
  /** The Doc's file name (the förening's text: UI only, never logged). */
  doc_name: string;
  items: DraftItem[];
  doc_lines: DocLine[];
  carried: NoteItemRow[];
  dropped: string[];
  source_meeting_id: string | null;
  shared_with: string[];
  gen: number;
  journal: Journal | null;
  prepared_by: string | null;
  updated_at: string;
}

/** A table this database doesn't have yet (code deployed before 0033). */
export const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

const COLUMNS =
  "id, org_id, meeting_date, meeting_time, kind, format_profile_id, doc_id, tab_id, doc_name, items, doc_lines, carried, dropped, source_meeting_id, shared_with, prepared_by, updated_at, gen, journal";

async function one(label: string, query: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<PreparedAgenda | null> {
  const { data, error } = await query;
  if (error) {
    if (missingTable(error.code)) return null;
    throw new Error(`prepared_agendas: ${label}: ${error.message}`);
  }
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as PreparedAgenda[];
  return rows[0] ?? null;
}

/** The prepared agenda in `docId` (the start's lookup: server-side, never from the request body). */
export function preparedForDoc(orgId: string, docId: string, db: SupabaseClient = supabaseAdmin()) {
  return one("by doc", db.from("prepared_agendas").select(COLUMNS).eq("org_id", orgId).eq("doc_id", docId).limit(1));
}

/** The prepared agenda for a meeting date. */
export function preparedForDate(orgId: string, date: string, db: SupabaseClient = supabaseAdmin()) {
  return one("by date", db.from("prepared_agendas").select(COLUMNS).eq("org_id", orgId).eq("meeting_date", date).limit(1));
}

/** Today's prepared agenda, else the nearest upcoming one (`today`: `YYYY-MM-DD`, Stockholm). */
export function nextPrepared(orgId: string, today: string, db: SupabaseClient = supabaseAdmin()) {
  return one(
    "next",
    db.from("prepared_agendas").select(COLUMNS).eq("org_id", orgId).gte("meeting_date", today).order("meeting_date", { ascending: true }).limit(1),
  );
}

/** Upcoming prepared agendas (the förening page lists them). Empty without 0033. */
export async function upcomingPrepared(db: SupabaseClient, orgId: string, today: string): Promise<Pick<PreparedAgenda, "id" | "meeting_date" | "meeting_time" | "kind" | "doc_id" | "doc_name">[]> {
  const { data, error } = await db
    .from("prepared_agendas")
    .select("id, meeting_date, meeting_time, kind, doc_id, doc_name")
    .eq("org_id", orgId)
    .gte("meeting_date", today)
    .order("meeting_date", { ascending: true })
    .limit(5);
  if (error) {
    if (!missingTable(error.code)) console.error(`prepared_agendas: upcoming: ${error.message}`);
    return [];
  }
  return (data ?? []) as Pick<PreparedAgenda, "id" | "meeting_date" | "meeting_time" | "kind" | "doc_id" | "doc_name">[];
}

/** How long one "Skapa dagordning" may hold a prepared agenda. */
export const LEASE_MS = 120_000;

/**
 * Take the prepared agenda's lease (atomic: one conditional update), returning the row as it is
 * now, or null while someone else holds it. Every plan is made from this fresh row.
 */
export async function acquireLease(id: string, now = new Date(), db: SupabaseClient = supabaseAdmin()): Promise<PreparedAgenda | null> {
  const { data, error } = await db
    .from("prepared_agendas")
    .update({ busy_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq("id", id)
    // Quoted: the timestamp's "." would split a PostgREST filter.
    .or(`busy_until.is.null,busy_until.lt."${now.toISOString()}"`)
    .select(COLUMNS);
  if (error) throw new Error(`prepared_agendas: lease: ${error.message}`);
  return ((data ?? []) as PreparedAgenda[])[0] ?? null;
}

export async function releaseLease(id: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  const { error } = await db.from("prepared_agendas").update({ busy_until: null }).eq("id", id);
  if (error) console.error(`prepared_agendas: release: ${error.message}`);
}
