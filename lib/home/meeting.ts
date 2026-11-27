import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemRole } from "@/lib/db/types";
import { isCopy, isDecision, isTask } from "@/lib/meetings/summary";
import { docUrl } from "@/lib/ui/meetings";
import { canTick, countsMeeting, isMine, myPersonIds, type HomeMeeting, type HomeNoteRow, type HomePerson, type MyTask } from "./tasks";

// A förening meeting's page in the app (/orgs/<id>/mote/<meetingId>): its decisions and tasks
// from the stored notes, read with the user's own client (members only: RLS), and which tasks the
// user may tick (their own, or every one for an admin; only after a finished real meeting).

export interface MeetingTask extends MyTask {
  owner: string | null;
  canTick: boolean;
  mine: boolean;
}

export interface OrgMeetingPage {
  org: { id: string; name: string };
  meeting: { id: string; startedAt: string; status: string; title: string | null; isTest: boolean; endedAt?: string | null };
  decisions: string[];
  /** The Närvarande rows (as written: one name or a typed list each). */
  attendees?: string[];
  tasks: MeetingTask[];
  isAdmin: boolean;
  docUrl: string | null;
}

const text = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim() || null;

export async function loadOrgMeeting(db: SupabaseClient, userId: string, orgId: string, meetingId: string): Promise<OrgMeetingPage | null> {
  const [{ data: org, error: e1 }, { data: meeting, error: e2 }, { data: member, error: e3 }] = await Promise.all([
    db.from("orgs").select("id, name, kind").eq("id", orgId).maybeSingle(),
    db.from("meetings").select("*").eq("id", meetingId).eq("org_id", orgId).maybeSingle(),
    db.from("org_members").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle(),
  ]);
  if (e1 || e2 || e3) throw new Error(`loadOrgMeeting: ${(e1 ?? e2 ?? e3)!.message}`);
  if (!org || org.kind === "privat" || !meeting || !member) return null;
  const m = meeting as HomeMeeting & { notes_tab_id?: string | null; ended_at?: string | null };
  const [{ data: rows, error: e4 }, { data: people, error: e5 }] = await Promise.all([
    db.from("note_items").select("*").eq("meeting_id", meetingId).order("position"),
    db.from("people").select("id, org_id, name, role, member_user_id").eq("org_id", orgId),
  ]);
  if (e4 || e5) throw new Error(`loadOrgMeeting: ${(e4 ?? e5)!.message}`);
  return buildOrgMeeting({
    userId,
    org: { id: org.id, name: org.name },
    meeting: m,
    role: member.role as string,
    rows: (rows ?? []) as HomeNoteRow[],
    people: (people ?? []) as HomePerson[],
  });
}

/**
 * The page from rows already read as the user (pure): the loader above, and the MCP server's
 * get_meeting, which reads the same rows through its mcp_* functions (0060).
 */
export function buildOrgMeeting(input: {
  userId: string;
  org: { id: string; name: string };
  meeting: HomeMeeting & { ended_at?: string | null };
  role: string;
  rows: HomeNoteRow[];
  people: HomePerson[];
}): OrgMeetingPage {
  const { userId, org, role } = input;
  const orgId = org.id;
  const m = input.meeting;
  const meetingId = m.id;
  const member = { role };
  const all = input.rows;
  const roles = (m.agenda_roles ?? {}) as Record<string, ItemRole>;
  const shown = all.filter(
    (r) => !r.deleted_by_human && text(r.text) && !(r.anchor && (roles[r.anchor] === "checkin" || r.anchor.startsWith("info."))),
  );
  const chain = (r: HomeNoteRow) => ({ ...r, kind: r.kind ?? null, done: r.done ?? false, copy_of: r.copy_of ?? null, carried_from_meeting: r.carried_from_meeting ?? null, carried_from_id: r.carried_from_id ?? null });
  const doneCopies = new Set(all.filter((r) => isCopy(r) && r.done).map((r) => r.copy_of ?? r.id.slice(0, -2)));
  const orgPeople = input.people;
  const me = myPersonIds(orgPeople, orgId, userId);
  const isAdmin = member.role === "admin";
  const open = countsMeeting(m);
  const tasks: MeetingTask[] = shown
    .filter((r) => isTask(chain(r)))
    .map((r) => {
      const mine = isMine(r, orgPeople, me);
      const done = Boolean(r.done) || doneCopies.has(r.id);
      return {
        key: `n:${meetingId}:${r.id}`,
        kind: "note" as const,
        spaceId: orgId,
        spaceName: org.name,
        spaceKind: "forening" as const,
        meetingId,
        itemId: r.id,
        text: text(r.text)!,
        owner: r.locked ? null : text(r.owner),
        due: r.locked ? null : text(r.due),
        dueDate: r.due_date ?? null,
        doneWhen: r.locked ? null : text(r.done_when),
        contextName: null,
        done,
        meetingAt: m.started_at,
        position: r.position,
        mine,
        canTick: open && !done && canTick({ mine, isAdmin }),
      };
    });
  return {
    org: { id: org.id, name: org.name },
    meeting: {
      id: m.id,
      startedAt: m.started_at,
      status: m.status,
      title: (typeof m.title === "string" && m.title.trim()) || null,
      isTest: Boolean(m.is_test),
      endedAt: m.ended_at ?? null,
    },
    decisions: shown.filter((r) => isDecision(chain(r))).map((r) => text(r.text)!),
    attendees: shown.filter((r) => r.section === "attendees").map((r) => text(r.text)!),
    tasks,
    isAdmin,
    docUrl: m.doc_id ? docUrl(m.doc_id) : null,
  };
}
