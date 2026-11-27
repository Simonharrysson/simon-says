import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCustomers, type CustomerRow } from "@/lib/db/foretag";
import { listTeams } from "@/lib/foretag/teams";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { loadMeetingList, type MeetingListInfo } from "@/lib/meetings/list";
import type { GroupRow } from "./tree";

// The Företag page's data (0050). Meetings, groups, people and customers are read with the
// user's own client, so RLS decides what shows; only the member list (e-mails) is read with the
// service role, after RLS let the user read the company.

export interface ForetagMeeting {
  id: string;
  status: "live" | "ending" | "done" | "abandoned";
  started_at: string;
  ended_at: string | null;
  started_by: string | null;
  group_id: string | null;
  private: boolean;
  context_id: string | null;
  is_test?: boolean | null;
}

export interface ForetagPerson {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  member_user_id: string | null;
  group_id: string | null;
  canvas_x?: number | null;
  canvas_y?: number | null;
}

export interface ForetagPageData {
  groups: GroupRow[];
  people: ForetagPerson[];
  members: OrgMember[];
  meetings: ForetagMeeting[];
  meetingInfo: Record<string, MeetingListInfo>;
  customers: CustomerRow[];
  /** The viewer's node (null: unplaced). */
  myGroupId: string | null;
  /** This user's own running meeting (a starter runs one at a time; the company runs several). */
  myLiveId: string | null;
}

export async function loadForetagPage(db: SupabaseClient, orgId: string, userId: string, titleAnd: string): Promise<ForetagPageData> {
  const [groups, peopleRes, meetingsRes, customers, members, meetingInfo] = await Promise.all([
    listTeams(db, orgId),
    db.from("people").select("id, name, role, email, member_user_id, group_id, canvas_x, canvas_y").eq("org_id", orgId).order("name"),
    db
      .from("meetings")
      .select("id, status, started_at, ended_at, started_by, group_id, private, context_id, is_test")
      .eq("org_id", orgId)
      .order("started_at", { ascending: false })
      .limit(200),
    listCustomers(db, orgId),
    orgMemberList(orgId),
    loadMeetingList(db, orgId, titleAnd).catch(() => ({}) as Record<string, MeetingListInfo>),
  ]);
  if (peopleRes.error) throw new Error(`foretag page: people: ${peopleRes.error.message}`);
  if (meetingsRes.error) throw new Error(`foretag page: meetings: ${meetingsRes.error.message}`);
  const people = (peopleRes.data ?? []) as ForetagPerson[];
  const meetings = (meetingsRes.data ?? []) as ForetagMeeting[];
  const myGroupId = people.find((p) => p.member_user_id === userId && p.group_id)?.group_id ?? null;
  const myLiveId = meetings.find((m) => m.started_by === userId && (m.status === "live" || m.status === "ending"))?.id ?? null;
  return { groups, people, members, meetings, meetingInfo, customers, myGroupId, myLiveId };
}

/** The customer page: the customer (RLS: members), the meetings with it the user can see, and their open tasks. */
export async function loadCustomerPage(db: SupabaseClient, orgId: string, customerId: string) {
  const { data: customer, error } = await db.from("contexts").select("id, name, domain").eq("id", customerId).eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`customer page: ${error.message}`);
  if (!customer || !customer.domain) return null;
  const { data: meetings, error: e2 } = await db
    .from("meetings")
    .select("id, status, started_at, ended_at, started_by, group_id, private, context_id, is_test")
    .eq("org_id", orgId)
    .eq("context_id", customerId)
    .order("started_at", { ascending: false });
  if (e2) throw new Error(`customer page: meetings: ${e2.message}`);
  const ids = ((meetings ?? []) as ForetagMeeting[]).map((m) => m.id);
  const { data: rows, error: e3 } = ids.length
    ? await db
        .from("note_items")
        .select("meeting_id, id, text, owner, due, due_date, done, deleted_by_human, section, kind, copy_of")
        .in("meeting_id", ids)
        .eq("section", "action")
    : { data: [], error: null };
  if (e3) throw new Error(`customer page: tasks: ${e3.message}`);
  const open = ((rows ?? []) as { meeting_id: string; id: string; text: string; owner: string | null; due: string | null; done: boolean | null; deleted_by_human: boolean; copy_of: string | null }[])
    .filter((r) => !r.deleted_by_human && !r.done && !r.copy_of && r.text.trim());
  return { customer: customer as CustomerRow, meetings: (meetings ?? []) as ForetagMeeting[], openTasks: open };
}
