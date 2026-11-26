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

/** Carry hops followed back to the root (a guard; real chains are one per meeting). */
const MAX_CHAIN = 100;

/**
 * Flip done false -> true on the source rows of carried tasks that are done, and on THEIR sources,
 * up the chain to the root. Returns rows updated. Service role bypasses RLS, so only source
 * meetings of this org (and same is_test) are touched; the chain stops at any other meeting.
 */
export async function propagateDone(
  rows: NoteItemRow[],
  orgId: string,
  isTest: boolean,
  db: SupabaseClient = supabaseAdmin(),
): Promise<number> {
  const bySource = new Map<string, Set<string>>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    // A done tasks copy (`-t`) reaches its primary's source as well (final review N3).
    const primary = row.copy_of ? byId.get(row.copy_of) : undefined;
    const r = row.carried_from_id == null && primary?.carried_from_id != null
      ? { ...row, carried_from_meeting: primary.carried_from_meeting, carried_from_id: primary.carried_from_id }
      : row;
    if (!r.done || !r.carried_from_meeting || !r.carried_from_id) continue;
    const ids = bySource.get(r.carried_from_meeting) ?? new Set<string>();
    ids.add(r.carried_from_id);
    bySource.set(r.carried_from_meeting, ids);
  }
  let updated = 0;
  // Up the chain to the root (a task carried 1 → 2 → 3 and closed in 3 closes 2 and 1 too). Each
  // level only reaches meetings of this org with the same is_test; `seen` stops a cycle.
  const seen = new Set<string>();
  let level = bySource;
  for (let depth = 0; level.size > 0 && depth < MAX_CHAIN; depth++) {
    const { data: ok, error: e1 } = await db
      .from("meetings")
      .select("id")
      .eq("org_id", orgId)
      .eq("is_test", isTest)
      .in("id", [...level.keys()]);
    if (e1) throw new Error(`propagateDone: ${e1.message}`);
    const next = new Map<string, Set<string>>();
    for (const m of (ok ?? []) as { id: string }[]) {
      const ids = [...level.get(m.id)!].filter((id) => !seen.has(`${m.id}\u0000${id}`));
      if (!ids.length) continue;
      for (const id of ids) seen.add(`${m.id}\u0000${id}`);
      const { data, error } = await db
        .from("note_items")
        .update({ done: true })
        .eq("meeting_id", m.id)
        .in("id", ids)
        .eq("done", false)
        .select("id");
      if (error) throw new Error(`propagateDone: ${error.message}`);
      updated += data?.length ?? 0;
      // Where these rows were carried from (already-done ones too: the chain may continue past them).
      const { data: sources, error: e2 } = await db
        .from("note_items")
        .select("carried_from_meeting, carried_from_id")
        .eq("meeting_id", m.id)
        .in("id", ids)
        .not("carried_from_id", "is", null);
      if (e2) throw new Error(`propagateDone: ${e2.message}`);
      for (const src of (sources ?? []) as { carried_from_meeting: string | null; carried_from_id: string }[]) {
        if (!src.carried_from_meeting) continue;
        const set = next.get(src.carried_from_meeting) ?? new Set<string>();
        set.add(src.carried_from_id);
        next.set(src.carried_from_meeting, set);
      }
    }
    level = next;
  }
  return updated;
}
