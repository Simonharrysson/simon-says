import "server-only";
import { createTaskHandoffs, viewerIds } from "@/lib/db/foretag";
import { supabaseAdmin } from "@/lib/supabase/admin";
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

/** Best effort: a failure is logged and retried by the next summary run (the call is idempotent). */
export async function holdCrossingTasks(meetingId: string): Promise<void> {
  try {
    const n = await createTaskHandoffs(meetingId);
    if (n) console.info(`meetings ${meetingId}: ${n} task(s) held for approval`);
  } catch (err) {
    console.error(`meetings ${meetingId}: task handoffs failed: ${(err as Error).message}`);
  }
}
