import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemRole } from "@/lib/db/types";
import { isDecision, isTask, type ChainItem } from "./summary";
import { meetingTitle } from "./title";

// The förening page's meeting list (Möten tab): per meeting a short title, whether it is a
// Testmöte, and "3 beslut · 5 uppgifter". Read with the caller's client (RLS: members only).
// Nothing here may break the page: a failed read only leaves the titles or counts out.

export interface MeetingListInfo {
  /** The title to show (lib/meetings/title.ts), or null: the date is the main line. */
  title: string | null;
  isTest: boolean;
  decisions: number;
  tasks: number;
}

const PAGE = 1000;
const ID_CHUNK = 100;
const BASE = "id, is_test, calendar_event, agenda_labels, agenda_roles";
// Decision and task rows, also legacy rows without a kind (as lib/dashboard/load.ts).
const ITEM_FILTER = "kind.in.(decision,task),and(kind.is.null,section.in.(decision,action))";

type Row = {
  id: string;
  title?: string | null;
  is_test?: boolean | null;
  calendar_event?: unknown;
  agenda_labels?: Record<string, string> | null;
  agenda_roles?: Record<string, ItemRole> | null;
};

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function meetingRows(db: SupabaseClient, orgId: string): Promise<Row[]> {
  // meetings.title (0048) may not exist yet while a deploy runs ahead of the migration: read without it.
  for (const columns of [`${BASE}, title`, BASE]) {
    const { data, error } = await db.from("meetings").select(columns).eq("org_id", orgId);
    if (!error) return (data ?? []) as unknown as Row[];
  }
  throw new Error("meeting list: meetings unreadable");
}

/** Decisions and tasks per meeting id (primary rows only, as the dashboard counts them). */
export function countItems(items: ChainItem[]): Map<string, { decisions: number; tasks: number }> {
  const out = new Map<string, { decisions: number; tasks: number }>();
  for (const r of items) {
    const c = out.get(r.meeting_id) ?? { decisions: 0, tasks: 0 };
    if (isDecision(r)) c.decisions++;
    else if (isTask(r)) c.tasks++;
    out.set(r.meeting_id, c);
  }
  return out;
}

async function itemRows(db: SupabaseClient, ids: string[]): Promise<ChainItem[]> {
  const out: ChainItem[] = [];
  for (const part of chunks(ids, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("note_items")
        .select("meeting_id, id, section, kind, done, deleted_by_human, copy_of, carried_from_meeting, carried_from_id")
        .in("meeting_id", part)
        .or(ITEM_FILTER)
        .order("meeting_id")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`meeting list: items: ${error.message}`);
      const rows = (data ?? []) as ChainItem[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/** Per meeting id; empty when the rows could not be read (the list then shows dates only). */
export async function loadMeetingList(db: SupabaseClient, orgId: string, and: string): Promise<Record<string, MeetingListInfo>> {
  try {
    const rows = await meetingRows(db, orgId);
    const counts = await itemRows(db, rows.map((r) => r.id)).then(countItems, (err: Error) => {
      console.error("org page: meeting counts unavailable", err?.message);
      return new Map<string, { decisions: number; tasks: number }>();
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        { title: meetingTitle(r, and), isTest: Boolean(r.is_test), decisions: counts.get(r.id)?.decisions ?? 0, tasks: counts.get(r.id)?.tasks ?? 0 },
      ]),
    );
  } catch (err) {
    console.error("org page: meeting list unavailable", (err as Error)?.message);
    return {};
  }
}
