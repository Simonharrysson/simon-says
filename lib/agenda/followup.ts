import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteItemRow } from "@/lib/db/types";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";

// "Från förra veckan": the previous meeting's open tasks are carried into this meeting's follow-up
// agenda item; marking a carried task done flows back to the source row.

/** Swedish order, numbers by value ("n2" before "n10"). */
const cmp = (a: string, b: string) => a.localeCompare(b, "sv", { numeric: true });

/**
 * Open tasks of one meeting, ordered by raw owner text then position (carriedItems does the label
 * grouping). Locked rows keep human text only. A primary whose tasks-section copy (`<id>-t`) is
 * done counts as done: "✓ klart" set through the copy lands only on the copy when the primary is
 * locked (R-A6 proxy, final review R2-I3), and a locked row is never written.
 */
export function openTasks(rows: NoteItemRow[]): NoteItemRow[] {
  const doneByCopy = new Set(rows.filter((r) => r.done && r.id.endsWith("-t")).map((r) => r.copy_of ?? r.id.slice(0, -2)));
  return rows
    .filter(
      (r) =>
        (r.kind === "task" || (r.kind == null && r.section === "action")) &&
        !r.copy_of &&
        !r.done &&
        !doneByCopy.has(r.id) &&
        !r.deleted_by_human &&
        !r.id.endsWith("-t"),
    )
    .map((r) => (r.locked ? { ...r, owner: null, due: null } : r))
    .sort(
      (a, b) => cmp(a.owner ?? "", b.owner ?? "") || a.position - b.position,
    );
}

/** Fresh rows (c1..cN) for the follow-up item, grouped by owner label (role or person). */
export function carriedItems(
  prevMeetingId: string,
  open: NoteItemRow[],
  followupAnchor: string,
  people: RolePerson[],
  groupBy: "role" | "person" = "role",
): NoteItemRow[] {
  const keyed = open.map((row, i) => {
    const person = row.owner ? resolveOwner(row.owner, people) : null;
    return {
      row,
      person,
      i,
      label: ownerLabel(person, row.owner ?? "", groupBy),
    };
  });
  // Label order, then id: fully deterministic.
  keyed.sort((a, b) => cmp(a.label, b.label) || cmp(a.row.id, b.row.id));
  return keyed.map(({ row, person }, position) => ({
    meeting_id: "",
    id: `c${position + 1}`,
    section: "action",
    kind: "task",
    anchor: followupAnchor,
    text: row.text,
    owner: row.owner,
    due: row.due,
    owner_person_id: person?.id ?? null,
    locked: false,
    deleted_by_human: false,
    done: false,
    carried_from_meeting: prevMeetingId,
    carried_from_id: row.id,
    copy_of: null,
    range_name: null,
    last_rendered_text: null,
    position,
  }));
}

/**
 * What a new meeting carries into "Från förra veckan" (final review R1/R2 false start):
 * - `adopted`: the open carried rows (c*) of the latest earlier meeting on the SAME Doc whose line
 *   is still in the Doc (`intact`): a false start already wrote them there, so the new meeting takes
 *   them over (same range, same source) instead of writing them a second time;
 * - `open`: the previous finished meeting's open tasks, minus every row an adopted one already
 *   stands for (by id when that meeting is the previous one, else by its source).
 * A carried row whose line is gone from the Doc (e.g. the Doc was cleared for a new week) is not
 * adopted, so it is carried again as a fresh line: the chain to later weeks never breaks.
 */
export function carryPlan(input: {
  prev: { id: string; rows: NoteItemRow[] } | null;
  sameDoc: { id: string; rows: NoteItemRow[] } | null;
  intact: (rangeName: string) => boolean;
}): { adopted: NoteItemRow[]; open: NoteItemRow[] } {
  const { prev, sameDoc } = input;
  const adopted = (sameDoc?.rows ?? []).filter(
    (r) => r.carried_from_id != null && r.range_name && !r.done && !r.deleted_by_human && input.intact(r.range_name),
  );
  if (!prev) return { adopted, open: [] };
  const sameIds = sameDoc?.id === prev.id ? new Set(adopted.map((r) => r.id)) : new Set<string>();
  const sources = new Set(adopted.map((r) => `${r.carried_from_meeting}\u0000${r.carried_from_id}`));
  const open = openTasks(prev.rows).filter((r) => !sameIds.has(r.id) && !sources.has(`${prev.id}\u0000${r.id}`));
  return { adopted, open };
}

/**
 * The latest meeting on `docId` (same org and is_test) that is over (done or abandoned), started
 * before `before`: a false start on the Doc the new meeting uses.
 */
export async function previousOnDoc(
  orgId: string,
  isTest: boolean,
  docId: string,
  before: Date,
  db: SupabaseClient = supabaseAdmin(),
): Promise<{ id: string; startedAt: string } | null> {
  const { data, error } = await db
    .from("meetings")
    .select("id, started_at")
    .eq("doc_id", docId)
    .eq("org_id", orgId)
    .eq("is_test", isTest)
    .in("status", ["done", "abandoned"])
    .lt("started_at", before.toISOString())
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`previousOnDoc: ${error.message}`);
  const row = (data ?? [])[0] as { id: string; started_at: string } | undefined;
  return row ? { id: row.id, startedAt: row.started_at } : null;
}

/**
 * Latest finished meeting of the org with the same is_test, started before `before`. A Testmöte
 * given `agendaDoc` also needs the same agenda_doc: the agenda Testmöte (A13) carries only from
 * agenda Testmöten, never from an old-style Testmöte's fictional meeting. Real meetings ignore it.
 */
export async function previousMeeting(
  orgId: string,
  isTest: boolean,
  before: Date,
  db: SupabaseClient = supabaseAdmin(),
  agendaDoc?: boolean,
): Promise<{ id: string; startedAt?: string } | null> {
  let query = db.from("meetings").select("id, started_at").eq("org_id", orgId).eq("is_test", isTest).eq("status", "done");
  if (isTest && agendaDoc !== undefined) query = query.eq("agenda_doc", agendaDoc);
  const { data, error } = await query
    .lt("started_at", before.toISOString())
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`previousMeeting: ${error.message}`);
  return data?.[0] ? { id: data[0].id as string, startedAt: data[0].started_at as string | undefined } : null;
}

/**
 * Flip done false -> true on the source rows of carried tasks that are done. Returns rows updated.
 * Service role bypasses RLS, so only source meetings of this org (and same is_test) are touched.
 */
export async function propagateDone(
  rows: NoteItemRow[],
  orgId: string,
  isTest: boolean,
  db: SupabaseClient = supabaseAdmin(),
): Promise<number> {
  const bySource = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.done || !r.carried_from_meeting || !r.carried_from_id) continue;
    const ids = bySource.get(r.carried_from_meeting) ?? new Set<string>();
    ids.add(r.carried_from_id);
    bySource.set(r.carried_from_meeting, ids);
  }
  if (bySource.size === 0) return 0;
  const { data: ok, error: e1 } = await db
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_test", isTest)
    .in("id", [...bySource.keys()]);
  if (e1) throw new Error(`propagateDone: ${e1.message}`);
  let updated = 0;
  for (const m of (ok ?? []) as { id: string }[]) {
    const { data, error } = await db
      .from("note_items")
      .update({ done: true })
      .eq("meeting_id", m.id)
      .in("id", [...bySource.get(m.id)!])
      .eq("done", false)
      .select("id");
    if (error) throw new Error(`propagateDone: ${error.message}`);
    updated += data?.length ?? 0;
  }
  return updated;
}
