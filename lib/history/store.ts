import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoryItem, HistoryKind, HistoryMeeting } from "./types";

// Imported protocols (0032) read with the caller's client (RLS: members of the org) and written
// through save_history_protocol (admins only). Items are read in pages past PostgREST's cap.

const PAGE = 1000;

export interface HistorySummary {
  count: number;
  first: string | null;
  last: string | null;
}

export async function historySummary(db: SupabaseClient, orgId: string): Promise<HistorySummary> {
  const { data, error } = await db.from("history_protocols").select("meeting_date").eq("org_id", orgId).order("meeting_date");
  if (error) throw new Error(`history: protocols: ${error.message}`);
  const dates = ((data ?? []) as { meeting_date: string }[]).map((r) => r.meeting_date);
  return { count: dates.length, first: dates[0] ?? null, last: dates.at(-1) ?? null };
}

interface ItemRow {
  protocol_id: string;
  position: number;
  kind: HistoryKind;
  text: string;
  topic: string | null;
  owner: string | null;
  done: boolean | null;
}

/** Every imported protocol of the org as history meetings, oldest first. */
export async function loadImportedHistory(db: SupabaseClient, orgId: string): Promise<HistoryMeeting[]> {
  const { data, error } = await db.from("history_protocols").select("id, meeting_date").eq("org_id", orgId).order("meeting_date");
  if (error) throw new Error(`history: protocols: ${error.message}`);
  const protocols = (data ?? []) as { id: string; meeting_date: string }[];
  if (!protocols.length) return [];
  const rows: ItemRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await db
      .from("history_items")
      .select("protocol_id, position, kind, text, topic, owner, done")
      .eq("org_id", orgId)
      .order("protocol_id")
      .order("position")
      .range(from, from + PAGE - 1);
    if (res.error) throw new Error(`history: items: ${res.error.message}`);
    const page = (res.data ?? []) as ItemRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const byProtocol = new Map<string, HistoryItem[]>();
  for (const r of rows) {
    const list = byProtocol.get(r.protocol_id) ?? [];
    list.push({ kind: r.kind, text: r.text, topic: r.topic, owner: r.owner, done: r.done });
    byProtocol.set(r.protocol_id, list);
  }
  return protocols.map((p) => ({ date: p.meeting_date, source: "import" as const, items: byProtocol.get(p.id) ?? [] }));
}

export async function saveImportedProtocol(
  db: SupabaseClient,
  input: { orgId: string; driveFileId: string; date: string; dateFrom: "doc" | "file"; items: HistoryItem[] },
): Promise<{ ok: true } | { ok: false; code: string | null; message: string }> {
  const { error } = await db.rpc("save_history_protocol", {
    p_org_id: input.orgId,
    p_drive_file_id: input.driveFileId,
    p_meeting_date: input.date,
    p_date_from: input.dateFrom,
    p_items: input.items,
  });
  return error ? { ok: false, code: error.code ?? null, message: error.message } : { ok: true };
}
