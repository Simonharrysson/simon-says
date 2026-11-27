"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/db/ids";
import { deletePerson, listPeople, myRole, renamePerson, setPersonRole, updateOrgSettings } from "@/lib/db/orgs";
import { validName } from "@/lib/names/validate";
import { recordStep, setDismissed } from "@/lib/onboarding/store";
import { isStepId } from "@/lib/onboarding/steps";
import { parseProfile, type OrgProfile, type ProfileErrors, type ProfileInput } from "@/lib/orgs/profile";
import { cleanEmail } from "@/lib/people/board";
import { validRole } from "@/lib/people/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Kom igång (todo #5): actions the wizard calls directly. All run as the signed-in user; RLS and
// the 0035 functions decide; the checks here only turn refusals into sentences (UI language).

/** `editPersonId`: the name is already on the list; the form offers to edit that person instead. */
export type ActionResult = { ok: true } | { ok: false; message: string; editPersonId?: string };
const fail = (message: string): ActionResult => ({ ok: false, message });
const OK: ActionResult = { ok: true };
const copy = () => getTranslations("onboarding.actions");
type Copy = Awaited<ReturnType<typeof copy>>;

async function adminDb(orgId: string) {
  if (!isUuid(orgId)) return null;
  const db = await createSupabaseServerClient();
  return (await myRole(db, orgId)) === "admin" ? db : null;
}

const refresh = (orgId: string) => {
  revalidatePath(`/orgs/${orgId}`);
  revalidatePath(`/orgs/${orgId}/kom-igang`);
};

export async function stepAction(orgId: string, step: string, how: "done" | "skipped"): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  if (!isStepId(step) || (how !== "done" && how !== "skipped")) return fail(t("unknownStep"));
  // A missing row (förening from before onboarding, opened from Inställningar) is fine: nothing to save.
  await recordStep(db, orgId, step, how);
  refresh(orgId);
  return OK;
}

export async function dismissAction(orgId: string, dismissed: boolean): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  await setDismissed(db, orgId, dismissed);
  refresh(orgId);
  return OK;
}

export interface BoardInput {
  name: string;
  role: string;
  email: string;
}

function checkInput(input: BoardInput, t: Copy): { name: string; role: string | null; email: string | null } | string {
  const name = validName(input.name);
  if (!name) return t("nameRequired");
  const role = input.role.trim() ? validRole(input.role) : null;
  if (input.role.trim() && !role) return t("roleInvalid");
  const email = input.email.trim() ? cleanEmail(input.email) : null;
  if (input.email.trim() && !email) return t("emailInvalid");
  return { name, role, email };
}

async function setEmail(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, personId: string, email: string | null, t: Copy): Promise<string | null> {
  const { data, error } = await db.rpc("set_person_email", { p_person_id: personId, p_email: email ?? "" });
  if (error) throw new Error(`set_person_email: ${error.message}`);
  if (data === "taken") return t("emailTaken");
  if (data === "invalid") return t("emailInvalid");
  if (data !== "ok") return t("adminOnly");
  return null;
}

/**
 * Adds someone to the board: a person (name, role) and, with an e-mail, an invite that links
 * them to their account when they join. `memberUserId`: names a member who has no person yet.
 */
export async function addBoardPersonAction(orgId: string, input: BoardInput, memberUserId?: string): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  const v = checkInput(input, t);
  if (typeof v === "string") return fail(v);
  // One transaction (add_board_person, 0035): the person, role and e-mail are saved together or not at all.
  const { data, error } = await db.rpc("add_board_person", {
    p_org_id: orgId,
    p_name: v.name,
    p_role: v.role ?? "",
    p_email: v.email ?? "",
    p_member_user_id: memberUserId && isUuid(memberUserId) ? memberUserId : null,
  });
  if (error) {
    console.error(`add_board_person: ${error.message}`.slice(0, 200));
    return fail(t("addFailed"));
  }
  const res = data as { result: string; id?: string };
  if (res.result === "duplicate" && res.id) {
    return {
      ok: false,
      message: memberUserId ? t("duplicateMember", { name: v.name }) : t("duplicate", { name: v.name }),
      editPersonId: res.id,
    };
  }
  if (res.result === "taken") return fail(t("emailTaken"));
  if (res.result === "invalid") return fail(t("checkFields"));
  if (res.result !== "ok") return fail(t("adminOnly"));
  refresh(orgId);
  return OK;
}

export async function updateBoardPersonAction(orgId: string, personId: string, input: BoardInput): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  const v = checkInput(input, t);
  if (typeof v === "string") return fail(v);
  const people = isUuid(personId) ? await listPeople(db, orgId) : [];
  const current = people.find((p) => p.id === personId);
  if (!current) return fail(t("gone"));
  if (current.name !== v.name && !(await renamePerson(db, personId, v.name))) return fail(t("duplicate", { name: v.name }));
  if ((current.role ?? null) !== v.role && !(await setPersonRole(db, personId, v.role))) return fail(t("roleFailed"));
  if ((current.email ?? null) !== v.email) {
    const msg = await setEmail(db, personId, v.email, t);
    if (msg) return fail(msg);
  }
  refresh(orgId);
  return OK;
}

export async function removeBoardPersonAction(orgId: string, personId: string): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  const people = isUuid(personId) ? await listPeople(db, orgId) : [];
  if (!people.some((p) => p.id === personId)) return fail(t("gone"));
  await deletePerson(db, personId);
  refresh(orgId);
  return OK;
}

/**
 * "Det stämmer inte" on a "Nyss kopplad" row (0051): the admin undoes a member's self link. Only a
 * self link (self_linked_at set); the trigger clears self_linked_at with the link. The person stays.
 */
export async function undoSelfLinkAction(orgId: string, personId: string): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  if (!isUuid(personId)) return fail(t("gone"));
  const { data, error } = await db
    .from("people")
    .update({ member_user_id: null })
    .eq("id", personId)
    .eq("org_id", orgId)
    .not("self_linked_at", "is", null)
    .select("id");
  if (error) return fail(t("adminOnly"));
  if ((data ?? []).length === 0) return fail(t("gone"));
  refresh(orgId);
  return OK;
}

/** Step 6: records (or withdraws) that a person has said yes to having their voice learned later. */
export async function voiceConsentAction(orgId: string, personId: string, consent: boolean): Promise<ActionResult> {
  const t = await copy();
  if (!isUuid(orgId) || !isUuid(personId)) return fail(t("gone"));
  const db = await createSupabaseServerClient();
  const people = await listPeople(db, orgId);
  if (!people.some((p) => p.id === personId)) return fail(t("gone"));
  const { data, error } = await db.rpc("set_voice_consent", { p_person_id: personId, p_consent: consent });
  if (error || data !== true) return fail(t("adminOnly"));
  refresh(orgId);
  return OK;
}

/** Step 1: the förening's name (the same rule as Inställningar). */
export async function renameOrgAction(orgId: string, name: string): Promise<ActionResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return fail(t("adminOnly"));
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 100) return fail(t("orgName"));
  if (!(await updateOrgSettings(db, orgId, { name: clean }))) return fail(t("adminOnly"));
  refresh(orgId);
  return OK;
}

export type ProfileResult = { ok: true; profile: OrgProfile } | { ok: false; message: string; errors?: ProfileErrors };

/**
 * "Om oss" (todo #13, 0044): the short text and the links, from Inställningar and step 1. The
 * parser gives the canonical form the database checks accept; RLS and the column grant decide.
 */
export async function saveProfileAction(orgId: string, input: ProfileInput): Promise<ProfileResult> {
  const t = await copy();
  const db = await adminDb(orgId);
  if (!db) return { ok: false, message: t("adminOnly") };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const parsed = parseProfile({ about: str(input?.about), website: str(input?.website), facebook: str(input?.facebook), instagram: str(input?.instagram) }, await getLocale());
  if (!parsed.ok) return { ok: false, message: (await getTranslations("profile"))("checkFields"), errors: parsed.errors };
  if (!(await updateOrgSettings(db, orgId, parsed.profile))) return { ok: false, message: t("adminOnly") };
  refresh(orgId);
  return { ok: true, profile: parsed.profile };
}
