"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { isAdminEmail } from "@/lib/testmeeting/admin";
import { isUuid } from "@/lib/db/ids";
import { validName } from "@/lib/names/validate";
import { afterJoinPath, welcomePath, whoamiError } from "@/lib/people/whoami";
import {
  addPerson,
  addSelfPerson,
  claimPerson,
  createOrg,
  isLinkedIn,
  deleteMeeting,
  deleteOrg,
  deletePerson,
  getOrg,
  joinOrg,
  leaveOrg,
  listPeople,
  myRole,
  removeMember,
  renamePerson,
  rotateInviteCode,
  setMemberRole,
  setPersonRole,
  setSummarySettings,
  updateOrgSettings,
} from "@/lib/db/orgs";
import type { SummaryMode } from "@/lib/db/types";
import { shareOrgDocsWithNewMember } from "@/lib/docs/access";
import { adoptFormat, chooseStandardFormat } from "@/lib/formats/store";
import { endFromOrgPage } from "@/lib/meetings/end-from-org";
import { reconcileAfter } from "@/lib/foretag/reconcile";
import { END_BUDGET_MS, finishMeeting } from "@/lib/meetings/tick";
import { validRole } from "@/lib/people/roles";
import { LOGO_BUCKET, logoPath } from "@/lib/orgs/logo";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server actions for the org pages. All run as the signed-in user; RLS decides what's allowed.

const field = (form: FormData, name: string) => form.get(name)?.toString() ?? "";

function orgIdFrom(form: FormData): string {
  const id = field(form, "orgId");
  if (!isUuid(id)) redirect("/orgs");
  return id;
}

/** Where an org's list page is: /foretag for a company (0050), /orgs for a förening. */
async function listPathOf(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string): Promise<"/foretag" | "/orgs"> {
  return (await getOrg(db, orgId))?.kind === "foretag" ? "/foretag" : "/orgs";
}

export async function createOrgAction(form: FormData): Promise<void> {
  const db = await createSupabaseServerClient();
  const { data } = await db.auth.getUser();
  const user = data.user;
  // ADMIN_EMAILS skip the create limits (0041): the insert goes through the service role.
  const env = getEnv();
  const exempt = user && isAdminEmail(user.email, env.ADMIN_EMAILS, env.ALARM_EMAIL) ? user.id : undefined;
  const result = await createOrg(exempt ? supabaseAdmin() : db, field(form, "name"), exempt);
  if (!result.ok) redirect(`/orgs?fel=${result.reason}`);
  // A new förening starts Kom igång (todo #5); every step can be skipped.
  redirect(`/orgs/${result.id}/kom-igang`);
}

export async function joinOrgAction(form: FormData): Promise<void> {
  const db = await createSupabaseServerClient();
  const code = field(form, "code");
  // Already a member (RLS shows a förening's row to its members only): reopening the invite
  // link is no new join, so no welcome and no Doc sharing again.
  const { data: existing } = code ? await db.from("orgs").select("id").eq("invite_code", code).maybeSingle() : { data: null };
  const wasMember = Boolean(existing);
  const orgId = await joinOrg(db, code);
  if (!orgId) redirect("/orgs?fel=inbjudan");
  const { data } = await db.auth.getUser();
  const user = data.user;
  const org = await getOrg(db, orgId);
  // Företag (0050): admins place people; no "Vem av dessa är du?" (0051 is föreningar only).
  if (org?.kind === "foretag") {
    // The top rail gains Företag (from the layout) with the first company.
    revalidatePath("/", "layout");
    redirect(`/orgs/${orgId}`);
  }
  if (user?.email && !wasMember) {
    // The förening's earlier meeting Docs, shared through each starter's grant after the redirect.
    // (Företag returned above: a new member is unplaced and sees no group's meetings, so no Docs.)
    const member = { id: user.id, email: user.email };
    after(() =>
      shareOrgDocsWithNewMember(orgId, member).catch((e: Error) => console.error(`join share: ${e.message}`)),
    );
  }
  // The join trigger (0035) already linked them when an admin wrote their e-mail at their name;
  // otherwise "Vem av dessa är du?" (0051).
  const linked = user ? await isLinkedIn(db, orgId, user.id) : false;
  redirect(wasMember && linked ? `/orgs/${orgId}` : afterJoinPath(orgId, linked));
}

/** "Vem av dessa är du?": the member taps their name (0051 checks: a member, an unlinked person, only themselves). */
export async function claimPersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  const error = whoamiError(isUuid(personId) ? await claimPerson(db, personId) : "forbidden");
  redirect(error ? `/orgs/${orgId}/vem?fel=${error}` : welcomePath(orgId));
}

/** "Jag finns inte med": the member adds their own name (+ optional role), linked to them. */
export async function addSelfAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const name = validName(field(form, "name"));
  if (!name) redirect(`/orgs/${orgId}/vem?fel=namn&ny=1`);
  const rawRole = field(form, "role");
  const role = validRole(rawRole);
  if (rawRole.trim() !== "" && role === null) redirect(`/orgs/${orgId}/vem?fel=roll&ny=1`);
  const db = await createSupabaseServerClient();
  const error = whoamiError(await addSelfPerson(db, orgId, name, role));
  redirect(error ? `/orgs/${orgId}/vem?fel=${error}&ny=1` : welcomePath(orgId));
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
    require_task_fields: form.get("require_task_fields") === "on",
  });
  revalidatePath(`/orgs/${orgId}`);
}

const SUMMARY_MODES: SummaryMode[] = ["missed", "all", "selected", "off"];

/** Inställningar → "Sammanfattning efter mötet" (0037). The database checks admin. */
export async function updateSummaryAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const mode = field(form, "summary_mode") as SummaryMode;
  const people = form.getAll("summary_person").map(String).filter(isUuid);
  const db = await createSupabaseServerClient();
  if (!SUMMARY_MODES.includes(mode) || !(await setSummarySettings(db, orgId, mode, people))) {
    redirect(`/orgs/${orgId}?fel=sammanfattning`);
  }
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
  // A Företag: a new person may be linked to an account on the way (by e-mail).
  reconcileAfter(orgId);
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
  // A Företag: task owners are also found by role (handoffs are re-checked).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

export async function deletePersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const personId = field(form, "personId");
  const db = await createSupabaseServerClient();
  if (isUuid(personId)) await deletePerson(db, personId);
  // A Företag: their account loses what the person row gave it (Doc access, tasks).
  reconcileAfter(orgId);
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
  // A company goes back to Företag, a förening to Föreningar (read before it is gone).
  const list = await listPathOf(db, orgId);
  const result = await deleteOrg(db, orgId, field(form, "confirmName"));
  if (result === "deleted") {
    // The logo is not under the org's cascade (storage): remove it as the service role.
    await supabaseAdmin().storage.from(LOGO_BUCKET).remove([logoPath(orgId)]).catch(() => null);
    if (list === "/foretag") revalidatePath("/", "layout");
    redirect(list === "/foretag" ? "/foretag?klart=foretag-raderat" : "/orgs?klart=raderad");
  }
  redirect(`/orgs/${orgId}?fel=org-${result}`);
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const userId = field(form, "userId");
  const db = await createSupabaseServerClient();
  // A Företag (0050): whoever can no longer see a meeting loses its Doc (no-op for a förening).
  reconcileAfter(orgId);
  const result = isUuid(userId) ? await removeMember(db, orgId, userId) : "not_member";
  redirect(`/orgs/${orgId}?${result === "removed" ? "klart=medlem" : `fel=medlem-${result}`}`);
}

export async function leaveOrgAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const db = await createSupabaseServerClient();
  // A Företag (0050): whoever can no longer see a meeting loses its Doc (no-op for a förening).
  reconcileAfter(orgId);
  const list = await listPathOf(db, orgId);
  const result = await leaveOrg(db, orgId);
  if (result === "removed") {
    if (list === "/foretag") revalidatePath("/", "layout");
    redirect(list === "/foretag" ? "/foretag?klart=foretag-lamnat" : "/orgs?klart=lamnat");
  }
  redirect(`/orgs/${orgId}?fel=medlem-${result}`);
}

/** Admins: make a member admin (`role=admin`) or take admin away (`role=member`). The DB keeps the last admin. */
export async function setMemberRoleAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const userId = field(form, "userId");
  const role = field(form, "role");
  const db = await createSupabaseServerClient();
  // A Företag (0050): whoever can no longer see a meeting loses its Doc (no-op for a förening).
  reconcileAfter(orgId);
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
