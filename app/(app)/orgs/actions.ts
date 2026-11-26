"use server";

import { after } from "next/server";
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
  leaveOrg,
  listPeople,
  myRole,
  removeMember,
  renamePerson,
  rotateInviteCode,
  setMemberRole,
  setPersonRole,
  updateOrgSettings,
} from "@/lib/db/orgs";
import { shareOrgDocsWithNewMember } from "@/lib/docs/access";
import { adoptFormat, chooseStandardFormat } from "@/lib/formats/store";
import { endFromOrgPage } from "@/lib/meetings/end-from-org";
import { END_BUDGET_MS, finishMeeting } from "@/lib/meetings/tick";
import { validRole } from "@/lib/people/roles";
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
  if (orgId) {
    // The förening's earlier meeting Docs, shared through each starter's grant after the redirect.
    const { data } = await db.auth.getUser();
    const user = data.user;
    if (user?.email) {
      const member = { id: user.id, email: user.email };
      after(() =>
        shareOrgDocsWithNewMember(orgId, member).catch((e: Error) => console.error(`join share: ${e.message}`)),
      );
    }
  }
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
  if (!(await addPerson(db, orgId, field(form, "name")))) redirect(`/orgs/${orgId}?fel=personnamn`);
  revalidatePath(`/orgs/${orgId}`);
}

export async function renamePersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  if (!isUuid(personId) || !(await renamePerson(db, personId, field(form, "name")))) {
    redirect(`/orgs/${orgId}?fel=personnamn`);
  }
  revalidatePath(`/orgs/${orgId}`);
}

/** Roles are set by the org's admin (spec G5): members get a refusal, not a silent no-op. */
export async function setPersonRoleAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  if ((await myRole(db, orgId)) !== "admin") redirect(`/orgs/${orgId}?fel=roll-admin`);
  const raw = field(form, "role");
  const role = validRole(raw);
  if (raw.trim() !== "" && role === null) redirect(`/orgs/${orgId}?fel=rollnamn`);
  // The person must belong to this org, or an admin of one org could edit another's people.
  const people = isUuid(personId) ? await listPeople(db, orgId) : [];
  if (!people.some((p) => p.id === personId) || !(await setPersonRole(db, personId, role))) {
    redirect(`/orgs/${orgId}?fel=rollnamn`);
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

/**
 * "Avsluta mötet" on a live meeting's row (admins and the starter). The final pass runs after
 * the response; if this function dies first, the cron finishes it (status `ending`).
 */
export async function endMeetingAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const meetingId = field(form, "meetingId");
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/orgs/${orgId}`);
  const result = isUuid(meetingId) ? await endFromOrgPage(db, user.id, meetingId) : "not_found";
  if (result === "ending") {
    const deadlineAt = new Date(Date.now() + END_BUDGET_MS);
    after(() =>
      finishMeeting(meetingId, { deadlineAt }).catch((e) => console.error(`end ${meetingId}: final pass failed: ${(e as Error).message}`)),
    );
  }
  redirect(`/orgs/${orgId}?${result === "ending" || result === "noop" ? "klart=avslutat" : `fel=avsluta-${result}`}`);
}

export async function deleteOrgAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  const result = await deleteOrg(db, orgId, field(form, "confirmName"));
  if (result === "deleted") redirect("/orgs?klart=raderad");
  redirect(`/orgs/${orgId}?fel=org-${result}`);
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const userId = field(form, "userId");
  const db = await createSupabaseServerClient();
  const result = isUuid(userId) ? await removeMember(db, orgId, userId) : "not_member";
  redirect(`/orgs/${orgId}?${result === "removed" ? "klart=medlem" : `fel=medlem-${result}`}`);
}

export async function leaveOrgAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  const result = await leaveOrg(db, orgId);
  if (result === "removed") redirect("/orgs?klart=lamnat");
  redirect(`/orgs/${orgId}?fel=medlem-${result}`);
}

/** Admins: make a member admin (`role=admin`) or take admin away (`role=member`). The DB keeps the last admin. */
export async function setMemberRoleAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const userId = field(form, "userId");
  const role = field(form, "role");
  const db = await createSupabaseServerClient();
  const result =
    isUuid(userId) && (role === "admin" || role === "member") ? await setMemberRole(db, orgId, userId, role) : "invalid";
  if (result === "ok" || result === "unchanged") redirect(`/orgs/${orgId}?klart=${role === "admin" ? "admin-ny" : "admin-bort"}`);
  redirect(`/orgs/${orgId}?fel=admin-${result}`);
}

/** Admins: switch the org's meeting format (`choice` = standard kind or `id:<profile id>`). RLS-style check is in the DB function. */
export async function changeFormatAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const choice = field(form, "choice");
  const db = await createSupabaseServerClient();
  try {
    if (choice.startsWith("id:")) {
      const id = choice.slice(3);
      if (isUuid(id)) await adoptFormat(db, orgId, id);
    } else if (choice === "veckomote" || choice === "styrelseprotokoll" || choice === "enkel") {
      await chooseStandardFormat(db, orgId, choice);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "42501") throw err;
  }
  revalidatePath(`/orgs/${orgId}`);
}
