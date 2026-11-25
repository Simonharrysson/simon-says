import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteItemRow } from "@/lib/db/types";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";

// "Från förra veckan": the previous meeting's open tasks are carried into this meeting's follow-up
// agenda item; marking a carried task done flows back to the source row.

const cmp = (a: string, b: string) => a.localeCompare(b, "sv");

/** Open tasks of one meeting, ordered by owner text then position. Locked rows keep human text only. */
export function openTasks(rows: NoteItemRow[]): NoteItemRow[] {
  return rows
    .filter(
      (r) =>
        (r.kind === "task" || (r.kind == null && r.section === "action")) &&
        !r.copy_of &&
        !r.done &&
        !r.deleted_by_human &&
        !r.id.endsWith("-t"),
    )
    .map((r) => (r.locked ? { ...r, owner: null, due: null } : r))
    .sort((a, b) => cmp(a.owner ?? "", b.owner ?? "") || a.position - b.position);
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
    return { row, person, i, label: ownerLabel(person, row.owner ?? "", groupBy) };
  });
  // Stable: label order, then the incoming (owner text, position) order.
  keyed.sort((a, b) => cmp(a.label, b.label) || a.i - b.i);
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

/** Latest finished meeting of the org with the same is_test, started before `before`. */
export async function previousMeeting(
  orgId: string,
  isTest: boolean,
  before: Date,
  db: SupabaseClient = supabaseAdmin(),
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_test", isTest)
    .eq("status", "done")
    .lt("started_at", before.toISOString())
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`previousMeeting: ${error.message}`);
  return data?.[0] ? { id: data[0].id as string } : null;
}

/** Flip done false -> true on the source rows of carried tasks that are done. Returns rows updated. */
export async function propagateDone(rows: NoteItemRow[], db: SupabaseClient = supabaseAdmin()): Promise<number> {
  let updated = 0;
  for (const r of rows) {
    if (!r.done || !r.carried_from_meeting || !r.carried_from_id) continue;
    const { data, error } = await db
      .from("note_items")
      .update({ done: true })
      .eq("meeting_id", r.carried_from_meeting)
      .eq("id", r.carried_from_id)
      .eq("done", false)
      .select("id");
    if (error) throw new Error(`propagateDone: ${error.message}`);
    updated += data?.length ?? 0;
  }
  return updated;
}
