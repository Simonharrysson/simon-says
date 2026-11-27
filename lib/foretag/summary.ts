import "server-only";
import { createTaskHandoffs, viewerIds } from "@/lib/db/foretag";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveOwner, type RolePerson } from "@/lib/people/roles";
import { audiencePeople } from "./audience";

// A Företag meeting's summary (0050): who it is for (the meeting's group + attendees, only viewers)
// and, first, its tasks for owners who can't see the meeting, held for approval (task_handoffs).

export interface ForetagScope {
  groupId: string | null;
  attendeeIds: string[];
  viewerIds: string[];
  /** person id → group id */
  personGroups: Map<string, string | null>;
}

export async function foretagScope(meetingId: string, orgId: string): Promise<ForetagScope> {
  const db = supabaseAdmin();
  const [meeting, attendees, people, viewers] = await Promise.all([
    db.from("meetings").select("group_id").eq("id", meetingId).maybeSingle(),
    db.from("meeting_attendees").select("user_id").eq("meeting_id", meetingId),
    db.from("people").select("id, group_id").eq("org_id", orgId),
    viewerIds(meetingId),
  ]);
  for (const r of [meeting, attendees, people]) if (r.error) throw new Error(`foretag summary: ${r.error.message}`);
  return {
    groupId: ((meeting.data as { group_id: string | null } | null)?.group_id ?? null) as string | null,
    attendeeIds: ((attendees.data ?? []) as { user_id: string }[]).map((a) => a.user_id),
    viewerIds: viewers,
    personGroups: new Map(((people.data ?? []) as { id: string; group_id: string | null }[]).map((p) => [p.id, p.group_id])),
  };
}

/** The people (of the förening-shaped list) a Företag summary goes to. */
export function foretagSummaryPeople<T extends { id: string; member_user_id?: string | null }>(people: T[], scope: ForetagScope): T[] {
  return audiencePeople({
    groupId: scope.groupId,
    people: people.map((p) => ({ ...p, member_user_id: p.member_user_id ?? null, group_id: scope.personGroups.get(p.id) ?? null })),
    attendeeIds: scope.attendeeIds,
    viewerIds: scope.viewerIds,
  }) as unknown as T[];
}

/**
 * Each open task's owner: the person link, else the owner text resolved by name or role (the same
 * rule as Mina uppgifter). Pure.
 */
export function taskOwners(
  rows: { id: string; section: string; owner: string | null; owner_person_id: string | null; deleted_by_human?: boolean | null; done?: boolean | null }[],
  people: RolePerson[],
): { item_id: string; person_id: string }[] {
  const out: { item_id: string; person_id: string }[] = [];
  for (const r of rows) {
    if (r.section !== "action" || r.deleted_by_human || r.done) continue;
    const id = r.owner_person_id ?? (r.owner ? resolveOwner(r.owner, people)?.id : null);
    if (id) out.push({ item_id: r.id, person_id: id });
  }
  return out;
}

/** Best effort: a failure is logged and retried by the next run (the call is idempotent). */
export async function holdCrossingTasks(meetingId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: m, error: me } = await db.from("meetings").select("org_id").eq("id", meetingId).maybeSingle();
    if (me || !m) throw new Error(me?.message ?? "meeting not found");
    const [rows, people] = await Promise.all([
      db.from("note_items").select("id, section, owner, owner_person_id, deleted_by_human, done").eq("meeting_id", meetingId).eq("section", "action"),
      db.from("people").select("id, name, role").eq("org_id", (m as { org_id: string }).org_id),
    ]);
    if (rows.error || people.error) throw new Error((rows.error ?? people.error)!.message);
    const n = await createTaskHandoffs(meetingId, taskOwners((rows.data ?? []) as Parameters<typeof taskOwners>[0], (people.data ?? []) as RolePerson[]));
    if (n) console.info(`meetings ${meetingId}: ${n} task(s) held for approval`);
  } catch (err) {
    console.error(`meetings ${meetingId}: task handoffs failed: ${(err as Error).message}`);
  }
}
