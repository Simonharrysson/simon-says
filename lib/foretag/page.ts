import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCustomers, listGroups, type CustomerRow } from "@/lib/db/foretag";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { loadMeetingList, type MeetingListInfo } from "@/lib/meetings/list";
import { supabaseAdmin } from "@/lib/supabase/admin";
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
  member_user_id: string | null;
  group_id: string | null;
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
  /** Any meeting running in the company, even one this user can't see (the start is one at a time). */
  companyBusy: boolean;
}

export async function loadForetagPage(db: SupabaseClient, orgId: string, userId: string, titleAnd: string): Promise<ForetagPageData> {
  const [groups, peopleRes, meetingsRes, customers, members, meetingInfo] = await Promise.all([
    listGroups(db, orgId),
    db.from("people").select("id, name, member_user_id, group_id").eq("org_id", orgId).order("name"),
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
  // The one-live-meeting guard (0027) is per company: say so instead of a failed start.
  const companyBusy = meetings.some((m) => m.status === "live" || m.status === "ending") || (await liveElsewhere(orgId));
  return { groups, people, members, meetings, meetingInfo, customers, myGroupId, companyBusy };
}

/** A live meeting the user can't see (counts only; nothing about it is shown). */
async function liveElsewhere(orgId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from("meetings")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("status", ["live", "ending"]);
  if (error) return false;
  return (count ?? 0) > 0;
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
