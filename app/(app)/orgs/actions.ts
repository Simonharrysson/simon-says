"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import {
  addPerson,
  createOrg,
  deleteMeeting,
  deleteOrg,
  deletePerson,
  joinOrg,
  renamePerson,
  rotateInviteCode,
  updateOrgSettings,
} from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server actions for the org pages. All run as the signed-in user; RLS decides what's allowed.

const field = (form: FormData, name: string) => form.get(name)?.toString() ?? "";

function orgIdFrom(form: FormData): string {
  const id = field(form, "orgId");
  if (!isUuid(id)) redirect("/orgs");
  return id;
}

export async function createOrgAction(form: FormData): Promise<void> {
  const db = await createSupabaseServerClient();
  const result = await createOrg(db, field(form, "name"));
  if (!result.ok) redirect(`/orgs?fel=${result.reason}`);
  redirect(`/orgs/${result.id}`);
}

export async function joinOrgAction(form: FormData): Promise<void> {
  const db = await createSupabaseServerClient();
  const orgId = await joinOrg(db, field(form, "code"));
  redirect(orgId ? `/orgs/${orgId}` : "/orgs?fel=inbjudan");
}

export async function updateOrgAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  const name = field(form, "name").trim();
  if (name.length < 1 || name.length > 100) redirect(`/orgs/${orgId}?fel=namn`);
  await updateOrgSettings(db, orgId, {
    name,
    share_transcript: form.get("share_transcript") === "on",
    show_on_status: form.get("show_on_status") === "on",
  });
  revalidatePath(`/orgs/${orgId}`);
}

export async function rotateInviteAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  await rotateInviteCode(db, orgId);
  revalidatePath(`/orgs/${orgId}`);
}

export async function addPersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  if (!(await addPerson(db, orgId, field(form, "name")))) redirect(`/orgs/${orgId}?fel=namn`);
  revalidatePath(`/orgs/${orgId}`);
}

export async function renamePersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  if (!isUuid(personId) || !(await renamePerson(db, personId, field(form, "name")))) {
    redirect(`/orgs/${orgId}?fel=namn`);
  }
  revalidatePath(`/orgs/${orgId}`);
}

export async function deletePersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  if (isUuid(personId)) await deletePerson(db, personId);
  revalidatePath(`/orgs/${orgId}`);
}

export async function deleteMeetingAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const meetingId = field(form, "meetingId");
  const db = await createSupabaseServerClient();
  const result = isUuid(meetingId) ? await deleteMeeting(db, meetingId) : "not_found";
  redirect(`/orgs/${orgId}?${result === "deleted" ? "klart=mote" : `fel=mote-${result}`}`);
}

export async function deleteOrgAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  const result = await deleteOrg(db, orgId, field(form, "confirmName"));
  if (result === "deleted") redirect("/orgs?klart=raderad");
  redirect(`/orgs/${orgId}?fel=org-${result}`);
}
