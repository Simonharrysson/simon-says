import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { GroupRow } from "@/lib/foretag/tree";

// Företag (0050) data access. Client calls run as the signed-in user (RLS and the admin functions
// decide); the service-role calls are for the server's start and summary paths only.

type Db = SupabaseClient;

function fail(what: string, error: { message: string }): never {
  throw new Error(`foretag: ${what}: ${error.message}`);
}

export async function listGroups(db: Db, orgId: string): Promise<GroupRow[]> {
  const { data, error } = await db
    .from("groups")
    .select("id, name, parent_group_id, depth, position, archived_at, head_person_id")
    .eq("org_id", orgId)
    .order("depth")
    .order("position");
  if (error) fail("groups", error);
  return (data ?? []) as GroupRow[];
}

/** Create (no id) or rename / move a group. False when refused (not admin, bad name, bad parent, cycle). */
export async function saveGroup(db: Db, orgId: string, input: { id?: string | null; name: string; parentId: string | null }): Promise<boolean> {
  const { data, error } = await db.rpc("set_group", { p_org_id: orgId, p_id: input.id ?? null, p_name: input.name.trim(), p_parent: input.parentId });
  if (error) {
    // The tree trigger's refusals (cycle, other company) and a name taken (unique index).
    if (error.code === "22023" || error.code === "23505") return false;
    fail("set_group", error);
  }
  return data !== null;
}

/** 0062: "Rapporterar till". `manager`: a person id; "top": no manager; "none": out of the tree. False when refused (not admin, a cycle, has reports). */
export async function setManager(db: Db, personId: string, to: { manager: string } | "top" | "none"): Promise<boolean> {
  const { data, error } = await db.rpc("set_manager", {
    p_person_id: personId,
    p_mode: typeof to === "string" ? to : "manager",
    p_manager_id: typeof to === "string" ? null : to.manager,
  });
  if (error) {
    // The tree trigger's refusals: a cycle, too deep.
    if (error.code === "22023") return false;
    fail("set_manager", error);
  }
  return data === true;
}

/** 0062: save card positions on the canvas (admins; the database decides). False when refused. */
export async function savePeopleCanvas(db: Db, orgId: string, positions: { id: string; x: number; y: number }[]): Promise<boolean> {
  const { data, error } = await db.rpc("set_people_canvas", { p_org_id: orgId, p_positions: positions });
  if (error) {
    if (error.code === "22023") return false;
    fail("set_people_canvas", error);
  }
  return typeof data === "number";
}

export type AddPersonResult = { ok: true; id: string } | { ok: false; reason: "forbidden" | "invalid" | "duplicate" | "taken" };

/** 0062 "Lägg till person": a person row (add_board_person, 0035: name, role, e-mail and its invite link). */
export async function addPerson(db: Db, orgId: string, input: { name: string; role: string; email: string }): Promise<AddPersonResult> {
  const { data, error } = await db.rpc("add_board_person", { p_org_id: orgId, p_name: input.name, p_role: input.role, p_email: input.email, p_member_user_id: null });
  if (error) fail("add_board_person", error);
  const r = data as { result: string; id?: string };
  return r.result === "ok" && r.id ? { ok: true, id: r.id } : { ok: false, reason: (r.result as "forbidden") ?? "invalid" };
}

export async function archiveGroup(db: Db, groupId: string): Promise<boolean> {
  const { data, error } = await db.rpc("archive_group", { p_id: groupId });
  if (error) fail("archive_group", error);
  return data === true;
}

export async function placePerson(db: Db, personId: string, groupId: string | null): Promise<boolean> {
  const { data, error } = await db.rpc("set_person_group", { p_person_id: personId, p_group_id: groupId });
  if (error) fail("set_person_group", error);
  return data === true;
}

/** Place a member account (its person row made when missing, named `name`). */
export async function placeMember(db: Db, orgId: string, userId: string, groupId: string | null, name: string): Promise<boolean> {
  const { data, error } = await db.rpc("place_member", { p_org_id: orgId, p_user_id: userId, p_group_id: groupId, p_name: name });
  if (error) {
    if (error.code === "23505") return false;
    fail("place_member", error);
  }
  return data !== null;
}

export type CreateForetagResult = { ok: true; id: string } | { ok: false; reason: "invalid" };

/** A new company (service role; the caller checked the allow-list). */
export async function createForetag(userId: string, name: string, rootName: string, personName: string): Promise<CreateForetagResult> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return { ok: false, reason: "invalid" };
  const { data, error } = await supabaseAdmin().rpc("create_foretag", { p_user: userId, p_name: trimmed, p_root_name: rootName, p_person_name: personName });
  if (error) fail("create_foretag", error);
  return { ok: true, id: data as string };
}

/** The accounts that can see a meeting (service role). */
export async function viewerIds(meetingId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc("foretag_viewer_ids", { p_meeting_id: meetingId });
  if (error) fail("viewer ids", error);
  return (data ?? []) as string[];
}

/** The accounts that will see a meeting not written yet (service role; the Doc's share list). */
export async function audienceIds(orgId: string, groupId: string | null, priv: boolean, startedBy: string, attendees: string[]): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc("foretag_audience_ids", {
    p_org: orgId,
    p_group: groupId,
    p_private: priv,
    p_started_by: startedBy,
    p_attendees: attendees,
  });
  if (error) fail("audience ids", error);
  return (data ?? []) as string[];
}

/** A Företag meeting's tasks for owners who can't see it, held for approval (service role). `owners`: each task's resolved owner. */
export async function createTaskHandoffs(meetingId: string, owners: { item_id: string; person_id: string; text?: string }[]): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("create_task_handoffs", { p_meeting_id: meetingId, p_owners: owners });
  if (error) fail("create handoffs", error);
  return (data as number) ?? 0;
}

export interface HandoffRow {
  id: string;
  org_id: string;
  meeting_id: string;
  item_id: string;
  owner_person_id: string;
  text: string;
  due: string | null;
  due_date: string | null;
  from_user_id: string | null;
  from_name: string | null;
  status: "pending" | "approved" | "dropped";
  done: boolean;
  created_at: string;
}

/** What RLS shows this user: approved tasks for them, and pending ones they may approve. */
export async function listHandoffs(db: Db, orgIds: string[]): Promise<HandoffRow[]> {
  if (!orgIds.length) return [];
  const { data, error } = await db
    .from("task_handoffs")
    .select("id, org_id, meeting_id, item_id, owner_person_id, text, due, due_date, from_user_id, from_name, status, done, created_at")
    .in("org_id", orgIds)
    .in("status", ["pending", "approved"]);
  if (error) fail("handoffs", error);
  return (data ?? []) as HandoffRow[];
}

export async function approveHandoff(db: Db, id: string, text: string): Promise<boolean> {
  const { data, error } = await db.rpc("approve_task_handoff", { p_id: id, p_text: text });
  if (error) fail("approve", error);
  return data === true;
}

export async function dropHandoff(db: Db, id: string): Promise<boolean> {
  const { data, error } = await db.rpc("drop_task_handoff", { p_id: id });
  if (error) fail("drop", error);
  return data === true;
}

export async function setHandoffDone(db: Db, id: string, done: boolean): Promise<boolean> {
  const { data, error } = await db.rpc("set_task_handoff_done", { p_id: id, p_done: done });
  if (error) fail("done", error);
  return data === true;
}

export interface CustomerRow {
  id: string;
  name: string;
  domain: string;
}

export async function listCustomers(db: Db, orgId: string): Promise<CustomerRow[]> {
  const { data, error } = await db.from("contexts").select("id, name, domain").eq("org_id", orgId).not("domain", "is", null).order("name");
  if (error) fail("customers", error);
  return (data ?? []) as CustomerRow[];
}

/** The customer for a domain, created on first sight (service role). */
export async function customerForDomain(orgId: string, domain: string, name: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().rpc("customer_for_domain", { p_org_id: orgId, p_domain: domain, p_name: name });
  if (error) fail("customer", error);
  return (data as string | null) ?? null;
}

/** The companies the signed-in user is a member of (RLS), oldest first. */
export async function listMyForetag(db: Db): Promise<{ id: string; name: string; role: "admin" | "member"; logo_updated_at: string | null }[]> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];
  const { data, error } = await db.from("orgs").select("id, name, kind, logo_updated_at, org_members!inner(role)").eq("org_members.user_id", user.id).eq("kind", "foretag").order("created_at");
  if (error) fail("my companies", error);
  return ((data ?? []) as unknown as { id: string; name: string; logo_updated_at: string | null; org_members: { role: "admin" | "member" }[] }[]).map((o) => ({
    id: o.id,
    name: o.name,
    role: o.org_members[0].role,
    logo_updated_at: o.logo_updated_at ?? null,
  }));
}

/** The ids of the companies `userId` is a member of (RLS), for the top rail (app/(app)/layout.tsx). */
export async function myForetagIds(db: Db, userId: string): Promise<string[]> {
  const { data, error } = await db.from("orgs").select("id, org_members!inner(user_id)").eq("org_members.user_id", userId).eq("kind", "foretag");
  if (error) fail("my company ids", error);
  return (data ?? []).map((o) => o.id as string);
}
