import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validName } from "@/lib/names/validate";
import type { MeetingRow, OrgMemberRow, OrgRow, PersonRow, SummaryMode } from "./types";

// Org, people and deletion operations. Each takes the signed-in user's client
// (createSupabaseServerClient), so RLS decides what is allowed; the functions only turn
// "0 rows" into a reason.

type Db = SupabaseClient;

/** `active`: a meeting is live or ending; it must be ended first (its sessions settle usage). */
export type DeleteResult = "deleted" | "not_found" | "forbidden" | "name_mismatch" | "active";

const ACTIVE = ["live", "ending"];
export type CreateOrgResult = { ok: true; id: string } | { ok: false; reason: "limit" | "cap" | "invalid" };

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

export async function listMyOrgs(db: Db): Promise<(OrgRow & { role: OrgMemberRow["role"] })[]> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];
  const { data, error } = await db
    .from("orgs")
    .select("*, org_members!inner(role)")
    .eq("org_members.user_id", user.id)
    .order("created_at");
  if (error) fail("listMyOrgs", error);
  // Föreningar only: the Privat space (0045) has its own page. Filtered here, not in the query, so
  // this works on a database before 0045 too.
  return (data ?? []).filter((org) => (org as OrgRow).kind !== "privat" && (org as OrgRow).kind !== "foretag").map(({ org_members, ...org }) => ({
    ...(org as OrgRow),
    role: (org_members as { role: OrgMemberRow["role"] }[])[0].role,
  }));
}

/**
 * `exemptFor`: a user id whose limits are skipped (ADMIN_EMAILS). The row is then inserted with
 * `db` = the service-role client, which the limit trigger lets through (see 0041).
 */
export async function createOrg(db: Db, name: string, exemptFor?: string): Promise<CreateOrgResult> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return { ok: false, reason: "invalid" };
  const row: { name: string; created_by?: string } = exemptFor ? { name: trimmed, created_by: exemptFor } : { name: trimmed };
  const { data, error } = await db.from("orgs").insert(row).select("id").single();
  if (error) {
    if (error.message.includes("org limit reached")) return { ok: false, reason: "limit" };
    if (error.message.includes("org creation cap reached")) return { ok: false, reason: "cap" };
    fail("createOrg", error);
  }
  return { ok: true, id: data.id };
}

export async function getOrg(db: Db, orgId: string): Promise<OrgRow | null> {
  const { data, error } = await db.from("orgs").select("*").eq("id", orgId).maybeSingle();
  if (error) fail("getOrg", error);
  return data;
}

export async function myRole(db: Db, orgId: string): Promise<OrgMemberRow["role"] | null> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;
  return memberRole(db, orgId, user.id);
}

/** A known user's role in an org (no second auth round trip), or null when not a member. */
export async function memberRole(db: Db, orgId: string, userId: string): Promise<OrgMemberRow["role"] | null> {
  const { data, error } = await db
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail("myRole", error);
  return data?.role ?? null;
}

export async function updateOrgSettings(
  db: Db,
  orgId: string,
  settings: Partial<Pick<OrgRow, "name" | "show_on_status" | "share_transcript" | "require_task_fields" | "about" | "website_url" | "facebook_url" | "instagram_url">>,
): Promise<boolean> {
  const { data, error } = await db.from("orgs").update(settings).eq("id", orgId).select("id");
  if (error) fail("updateOrgSettings", error);
  return (data ?? []).length > 0;
}

/**
 * "Sammanfattning efter mötet" (0037), admins only (the function checks): the mode and, for
 * "selected", the ticked people. False when the database refused (not admin, unknown person).
 */
export async function setSummarySettings(db: Db, orgId: string, mode: SummaryMode, personIds: string[]): Promise<boolean> {
  const { error } = await db.rpc("set_summary_settings", { p_org_id: orgId, p_mode: mode, p_person_ids: personIds });
  if (!error) return true;
  if (error.code === "42501" || error.code === "22023") return false;
  fail("setSummarySettings", error);
}

export async function rotateInviteCode(db: Db, orgId: string): Promise<string> {
  const { data, error } = await db.rpc("rotate_invite_code", { p_org_id: orgId });
  if (error) fail("rotateInviteCode", error);
  return data as string;
}

/** Org name for an invite code, or null if the code is unknown. */
export async function inviteOrgName(db: Db, code: string): Promise<string | null> {
  const { data, error } = await db.rpc("invite_org_name", { p_code: code });
  if (error) fail("inviteOrgName", error);
  return (data as string | null) ?? null;
}

/** Join as a member. Returns the org id, or null for an unknown code. */
export async function joinOrg(db: Db, code: string): Promise<string | null> {
  const { data, error } = await db.rpc("join_org", { p_code: code });
  if (error) fail("joinOrg", error);
  return (data as string | null) ?? null;
}

export async function listPeople(db: Db, orgId: string): Promise<PersonRow[]> {
  const { data, error } = await db.from("people").select("*").eq("org_id", orgId).order("name");
  if (error) fail("listPeople", error);
  return data ?? [];
}

/** People's names are speaker names too (prompt, Doc, transcript): the same rule as the speaker list. */
function cleanName(name: string): string | null {
  return validName(name);
}

export async function addPerson(db: Db, orgId: string, name: string): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  const { error } = await db.from("people").insert({ org_id: orgId, name: clean });
  // 23505: the name is already on the list (unique per org since 0016): nothing to add.
  if (error && error.code !== "23505") fail("addPerson", error);
  return true;
}

export async function renamePerson(db: Db, personId: string, name: string): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  const { data, error } = await db.from("people").update({ name: clean }).eq("id", personId).select("id");
  if (error?.code === "23505") return false; // another person already has that name
  if (error) fail("renamePerson", error);
  return (data ?? []).length > 0;
}

/** Sets (or clears, with null) a person's role. Admin-only: the database function returns false for anyone else. */
export async function setPersonRole(db: Db, personId: string, role: string | null): Promise<boolean> {
  const { data, error } = await db.rpc("set_person_role", { p_person_id: personId, p_role: role });
  if (error) fail("setPersonRole", error);
  return data === true;
}

export async function deletePerson(db: Db, personId: string): Promise<boolean> {
  const { data, error } = await db.from("people").delete().eq("id", personId).select("id");
  if (error) fail("deletePerson", error);
  return (data ?? []).length > 0;
}

export async function listMeetings(
  db: Db,
  orgId: string,
): Promise<Pick<MeetingRow, "id" | "status" | "started_at" | "ended_at" | "doc_id" | "started_by" | "agenda_doc">[]> {
  const { data, error } = await db
    .from("meetings")
    .select("id, status, started_at, ended_at, doc_id, started_by, agenda_doc")
    .eq("org_id", orgId)
    .order("started_at", { ascending: false });
  if (error) fail("listMeetings", error);
  return data ?? [];
}

/** removed | not_member | last_admin (the org must keep an admin) | not_found | forbidden. */
export type RemoveMemberResult = "removed" | "not_member" | "last_admin" | "not_found" | "forbidden";

/**
 * An admin removes a member (migration 0018). Their link in the people list is cleared; Google
 * Docs already shared with them stay shared.
 */
export async function removeMember(db: Db, orgId: string, userId: string): Promise<RemoveMemberResult> {
  const { data, error } = await db.rpc("remove_member", { p_org_id: orgId, p_user_id: userId });
  if (error?.code === "42501") return "forbidden";
  if (error) fail("removeMember", error);
  return data as RemoveMemberResult;
}

/** ok | unchanged | not_member | last_admin (the org must keep an admin) | not_found | invalid | forbidden. */
export type SetMemberRoleResult = "ok" | "unchanged" | "not_member" | "last_admin" | "not_found" | "invalid" | "forbidden";

/** An admin makes a member admin, or takes admin away (migration 0031). The last admin stays. */
export async function setMemberRole(
  db: Db,
  orgId: string,
  userId: string,
  role: "admin" | "member",
): Promise<SetMemberRoleResult> {
  const { data, error } = await db.rpc("set_member_role", { p_org_id: orgId, p_user_id: userId, p_role: role });
  if (error?.code === "42501") return "forbidden";
  if (error) fail("setMemberRole", error);
  return data as SetMemberRoleResult;
}

/** Leave an org yourself; the last admin can't (0018). */
export async function leaveOrg(db: Db, orgId: string): Promise<RemoveMemberResult> {
  const { data, error } = await db.rpc("leave_org", { p_org_id: orgId });
  if (error?.code === "42501") return "forbidden";
  if (error) fail("leaveOrg", error);
  return data as RemoveMemberResult;
}

/**
 * Delete an org and everything under it (cascade). Admins only, no live meeting; the caller
 * must type the org's exact name. The Google Docs stay in their owners' Drive. Its usage rows
 * and its entry in org_creations stay (caps and the lifetime creation cap).
 */
export async function deleteOrg(db: Db, orgId: string, confirmName: string): Promise<DeleteResult> {
  const org = await getOrg(db, orgId);
  if (!org) return "not_found";
  if (confirmName.trim() !== org.name) return "name_mismatch";
  const { data: active, error: activeError } = await db
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ACTIVE)
    .limit(1);
  if (activeError) fail("deleteOrg", activeError);
  if ((active ?? []).length > 0) return "active";
  const { data, error } = await db.from("orgs").delete().eq("id", orgId).select("id");
  if (error) fail("deleteOrg", error);
  return (data ?? []).length > 0 ? "deleted" : "forbidden";
}

/**
 * Delete a meeting with its sessions, speaker map, notes and events (cascade). Allowed for
 * the person who started it and org admins, once it is done or abandoned. The Google Doc
 * stays in Drive.
 */
export async function deleteMeeting(db: Db, meetingId: string): Promise<DeleteResult> {
  const { data: meeting, error: readError } = await db
    .from("meetings")
    .select("id, status")
    .eq("id", meetingId)
    .maybeSingle();
  if (readError) fail("deleteMeeting", readError);
  if (!meeting) return "not_found";
  if (ACTIVE.includes(meeting.status)) return "active";
  const { data, error } = await db.from("meetings").delete().eq("id", meetingId).select("id");
  if (error) fail("deleteMeeting", error);
  return (data ?? []).length > 0 ? "deleted" : "forbidden";
}
