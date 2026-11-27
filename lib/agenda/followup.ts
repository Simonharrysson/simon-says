import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteItemRow } from "@/lib/db/types";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { stripPlaceholders } from "@/lib/notes/tasks";
import { supabaseAdmin } from "@/lib/supabase/admin";

// "Från förra veckan": the previous meeting's open tasks are carried into this meeting's follow-up
// agenda item; marking a carried task done flows back to the source row.

/** Swedish order, numbers by value ("n2" before "n10"). */
const cmp = (a: string, b: string) => a.localeCompare(b, "sv", { numeric: true });

/**
 * The tree (Företag 0050, a förening with groups 0054): tasks carry only between meetings with the
 * same audience, i.e. the same group (or the whole org, `groupId` null), never from a Privat möte.
 * Null: no tree, every meeting of the org (as before).
 */
export type CarryScope = { groupId: string | null } | null;

/** `query` narrowed to `scope` (unchanged without one). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inScope<Q>(query: Q, scope: CarryScope | undefined): Q {
  // A Privat möte is never a source, with or without the tree (it outlives a förening's groups).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (query as any).eq("private", false);
  if (!scope) return q as Q;
  return (scope.groupId ? q.eq("group_id", scope.groupId) : q.is("group_id", null)) as Q;
}

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
    // A person's line: kept as written, minus our placeholders ("(deadline?)" is not theirs).
    .map((r) => (r.locked ? { ...r, text: stripPlaceholders(r.text), owner: null, due: null, done_when: null, due_date: null } : r))
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
    done_when: row.done_when ?? null,
    due_date: row.due_date ?? null,
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
    // Never a tasks copy (c1-t): it carries its primary's source too (N3), the primary stands for it.
    (r) => r.carried_from_id != null && !r.copy_of && !r.id.endsWith("-t") && r.range_name && !r.done && !r.deleted_by_human && input.intact(r.range_name),
  );
  if (!prev) return { adopted, open: [] };
  const sameIds = sameDoc?.id === prev.id ? new Set(adopted.map((r) => r.id)) : new Set<string>();
  const sources = new Set(adopted.map((r) => `${r.carried_from_meeting}\u0000${r.carried_from_id}`));
  // An open row stands for an adopted one by id, or (a prepared agenda drawn from an earlier
  // meeting whose tasks `prev` carried on) by the source both were carried from.
  const open = openTasks(prev.rows).filter(
    (r) =>
      !sameIds.has(r.id) &&
      !sources.has(`${prev.id}\u0000${r.id}`) &&
      !(r.carried_from_meeting && sources.has(`${r.carried_from_meeting}\u0000${r.carried_from_id}`)),
  );
  return { adopted, open };
}

/**
 * The rows a new meeting saves under its follow-up item `followup` (the start's pre-fill, and the
 * feature suite): `carryPlan`'s adopted rows (lines already in the Doc: a false start's, or a
 * prepared agenda's) moved to this meeting, then fresh rows for the rest of `prev`'s open tasks,
 * minus `excluded` sources (`<meeting>\u0000<item>`: tasks the ordförande took off a prepared
 * agenda, or deleted from its Doc). Fresh ids continue after the adopted ones. `fictional`: an
 * agenda Testmöte (no owner ids, Ruling 38).
 */
export function carriedForMeeting(input: {
  meetingId: string;
  prev: { id: string; rows: NoteItemRow[] } | null;
  sameDoc: { id: string; rows: NoteItemRow[] } | null;
  intact: (rangeName: string) => boolean;
  excluded?: Set<string>;
  followup: string;
  people: RolePerson[];
  groupBy: "role" | "person";
  fictional?: boolean;
}): NoteItemRow[] {
  const { prev, followup } = input;
  const plan = carryPlan({ prev: input.prev, sameDoc: input.sameDoc, intact: input.intact });
  const excluded = input.excluded ?? new Set<string>();
  const open = plan.open.filter(
    (r) =>
      !(prev && excluded.has(`${prev.id}\u0000${r.id}`)) &&
      !(r.carried_from_meeting && excluded.has(`${r.carried_from_meeting}\u0000${r.carried_from_id}`)),
  );
  const adopted = plan.adopted.map((r) => ({ ...r, meeting_id: input.meetingId, anchor: followup, position: 0 })).map((r, position) => ({ ...r, position }));
  const taken = new Set(adopted.map((r) => r.id));
  let next = Math.max(0, ...adopted.map((r) => Number(r.id.slice(1)) || 0));
  const fresh = prev
    ? carriedItems(prev.id, open, followup, input.people, input.groupBy).map((r) => {
        let id = `c${++next}`;
        while (taken.has(id)) id = `c${++next}`;
        return { ...r, id, position: adopted.length + r.position, meeting_id: input.meetingId, ...(input.fictional ? { owner_person_id: null } : {}) };
      })
    : [];
  return [...adopted, ...fresh];
}

/**
 * Latest finished real meeting of the org started before `before` whose format is one of
 * `kinds` (null: a meeting without a format row, i.e. v1): "the previous meeting of the same
 * kind" for a prepared agenda (Förbered möte). Looks at the 50 latest.
 */
export async function previousMeetingOfKinds(
  orgId: string,
  before: Date,
  kinds: (string | null)[],
  db: SupabaseClient = supabaseAdmin(),
  scope?: CarryScope,
): Promise<{ id: string; startedAt?: string } | null> {
  const { data, error } = await inScope(
    db.from("meetings").select("id, started_at, format_profile_id").eq("org_id", orgId).eq("is_test", false).eq("status", "done"),
    scope,
  )
    .lt("started_at", before.toISOString())
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`previousMeetingOfKinds: ${error.message}`);
  const rows = (data ?? []) as { id: string; started_at: string; format_profile_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.format_profile_id).filter((x): x is string => Boolean(x)))];
  const kindOf = new Map<string, string>();
  if (ids.length) {
    const { data: profiles, error: e2 } = await db.from("format_profiles").select("id, kind").in("id", ids);
    if (e2) throw new Error(`previousMeetingOfKinds: ${e2.message}`);
    for (const p of (profiles ?? []) as { id: string; kind: string }[]) kindOf.set(p.id, p.kind);
  }
  const hit = rows.find((r) => kinds.includes(r.format_profile_id ? (kindOf.get(r.format_profile_id) ?? null) : null));
  return hit ? { id: hit.id, startedAt: hit.started_at } : null;
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
  scope?: CarryScope,
): Promise<{ id: string; startedAt: string } | null> {
  const { data, error } = await inScope(
    db.from("meetings").select("id, started_at").eq("doc_id", docId).eq("org_id", orgId).eq("is_test", isTest),
    scope,
  )
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
  scope?: CarryScope,
): Promise<{ id: string; startedAt?: string } | null> {
  let query = inScope(db.from("meetings").select("id, started_at").eq("org_id", orgId).eq("is_test", isTest).eq("status", "done"), scope);
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
