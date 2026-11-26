import type { SupabaseClient } from "@supabase/supabase-js";
import { loadImportedHistory } from "@/lib/history/store";
import { buildOverview, type DashInput, type DashItem, type DashMeeting, type DashPerson, type Overview } from "./overview";

// Reads the org dashboard's rows with the caller's client (the page passes the user's, so RLS
// scopes everything to orgs they are a member of). Only counted meetings (not a Testmöte, ended),
// only decision and task rows (and their tasks copies), paged past PostgREST's 1000-row cap.
// The Översikt tab itself only reads `loadOverview` (meeting count and imported protocols).

const PAGE = 1000;
const ID_CHUNK = 100;
/** Older meetings than this many are left out (a weekly förening: about four years). */
export const MAX_MEETINGS = 200;

const ITEM_COLUMNS =
  "meeting_id, id, section, kind, text, owner, owner_person_id, due, done, deleted_by_human, copy_of, carried_from_meeting, carried_from_id, anchor, position";
// Decision and task rows, also legacy rows without a kind.
const ITEM_FILTER = "kind.in.(decision,task),and(kind.is.null,section.in.(decision,action))";

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function paged<T>(label: string, query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(`overview: ${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function loadOverviewInput(db: SupabaseClient, orgId: string): Promise<DashInput> {
  const [meetings, peopleRes] = await Promise.all([
    loadCountedMeetings(db, orgId, "id, org_id, started_at, status, is_test, layout, agenda_roles, agenda_labels"),
    db.from("people").select("id, name, role").eq("org_id", orgId),
  ]);
  if (peopleRes.error) throw new Error(`overview: people: ${peopleRes.error.message}`);
  const items: DashItem[] = [];
  for (const part of chunks(meetings.map((m) => m.id), ID_CHUNK)) {
    items.push(
      ...(await paged<DashItem>("items", (from, to) =>
        db.from("note_items").select(ITEM_COLUMNS).in("meeting_id", part).or(ITEM_FILTER).order("meeting_id").order("id").range(from, to),
      )),
    );
  }
  return { meetings, items, people: (peopleRes.data ?? []) as DashPerson[] };
}

async function loadCountedMeetings(db: SupabaseClient, orgId: string, columns: string): Promise<DashMeeting[]> {
  const { data, error } = await db
    .from("meetings")
    .select(columns)
    .eq("org_id", orgId)
    .eq("is_test", false)
    .in("status", ["done", "abandoned"])
    .order("started_at", { ascending: false })
    .limit(MAX_MEETINGS);
  if (error) throw new Error(`overview: meetings: ${error.message}`);
  return (data ?? []) as unknown as DashMeeting[];
}

/** The Översikt's basis: own counted meetings and imported old protocols (a failed history read only leaves those out). */
export async function loadOverview(db: SupabaseClient, orgId: string): Promise<Overview> {
  const [meetings, imported] = await Promise.all([
    loadCountedMeetings(db, orgId, "id, org_id, started_at, status, is_test"),
    loadImportedHistory(db, orgId).catch((err: Error) => {
      console.error("overview: imported protocols unavailable", err?.message);
      return [];
    }),
  ]);
  return buildOverview(orgId, meetings, imported);
}

export interface OrgGoal {
  id: string;
  title: string;
  why: string | null;
  approved_at: string;
}

export async function listGoals(db: SupabaseClient, orgId: string): Promise<OrgGoal[]> {
  const { data, error } = await db.from("org_goals").select("id, title, why, approved_at").eq("org_id", orgId).order("position");
  if (error) throw new Error(`overview: goals: ${error.message}`);
  return (data ?? []) as OrgGoal[];
}
