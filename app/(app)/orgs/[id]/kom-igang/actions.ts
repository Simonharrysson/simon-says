"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/db/ids";
import { deletePerson, listPeople, myRole, renamePerson, setPersonRole, updateOrgSettings } from "@/lib/db/orgs";
import { validName } from "@/lib/names/validate";
import { recordStep, setDismissed } from "@/lib/onboarding/store";
import { isStepId } from "@/lib/onboarding/steps";
import { cleanEmail } from "@/lib/people/board";
import { validRole } from "@/lib/people/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Kom igång (todo #5): actions the wizard calls directly. All run as the signed-in user; RLS and
// the 0035 functions decide; the checks here only turn refusals into Swedish sentences.

/** `editPersonId`: the name is already on the list; the form offers to edit that person instead. */
export type ActionResult = { ok: true } | { ok: false; message: string; editPersonId?: string };
const fail = (message: string): ActionResult => ({ ok: false, message });
const OK: ActionResult = { ok: true };
const ADMIN_ONLY = "Bara administratörer kan ändra det här.";

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
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  if (!isStepId(step) || (how !== "done" && how !== "skipped")) return fail("Okänt steg.");
  // A missing row (förening from before onboarding, opened from Inställningar) is fine: nothing to save.
  await recordStep(db, orgId, step, how);
  refresh(orgId);
  return OK;
}

export async function dismissAction(orgId: string, dismissed: boolean): Promise<ActionResult> {
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  await setDismissed(db, orgId, dismissed);
  refresh(orgId);
  return OK;
}

export interface BoardInput {
  name: string;
  role: string;
  email: string;
}

function checkInput(input: BoardInput): { name: string; role: string | null; email: string | null } | string {
  const name = validName(input.name);
  if (!name) return "Skriv ett namn, t.ex. Anna Berg.";
  const role = input.role.trim() ? validRole(input.role) : null;
  if (input.role.trim() && !role) return "Rollen kan vara högst fyra ord, t.ex. Kassör.";
  const email = input.email.trim() ? cleanEmail(input.email) : null;
  if (input.email.trim() && !email) return "Det ser inte ut som en e-postadress.";
  return { name, role, email };
}

async function setEmail(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, personId: string, email: string | null): Promise<string | null> {
  const { data, error } = await db.rpc("set_person_email", { p_person_id: personId, p_email: email ?? "" });
  if (error) throw new Error(`set_person_email: ${error.message}`);
  if (data === "taken") return "Någon annan i listan har redan den e-postadressen.";
  if (data === "invalid") return "Det ser inte ut som en e-postadress.";
  if (data !== "ok") return ADMIN_ONLY;
  return null;
}

/**
 * Adds someone to the board: a person (name, role) and, with an e-mail, an invite that links
 * them to their account when they join. `memberUserId`: names a member who has no person yet.
 */
export async function addBoardPersonAction(orgId: string, input: BoardInput, memberUserId?: string): Promise<ActionResult> {
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  const v = checkInput(input);
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
    return fail("Personen kunde inte läggas till. Försök igen.");
  }
  const res = data as { result: string; id?: string };
  if (res.result === "duplicate" && res.id) {
    return {
      ok: false,
      message: memberUserId
        ? `${v.name} finns redan i listan. Ändra ${v.name} och skriv in kontots e-postadress, så kopplas de ihop.`
        : `${v.name} finns redan i listan.`,
      editPersonId: res.id,
    };
  }
  if (res.result === "taken") return fail("Någon annan i listan har redan den e-postadressen.");
  if (res.result === "invalid") return fail("Kontrollera namn, roll och e-post och försök igen.");
  if (res.result !== "ok") return fail(ADMIN_ONLY);
  refresh(orgId);
  return OK;
}

export async function updateBoardPersonAction(orgId: string, personId: string, input: BoardInput): Promise<ActionResult> {
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  const v = checkInput(input);
  if (typeof v === "string") return fail(v);
  const people = isUuid(personId) ? await listPeople(db, orgId) : [];
  const current = people.find((p) => p.id === personId);
  if (!current) return fail("Personen finns inte längre. Ladda om sidan.");
  if (current.name !== v.name && !(await renamePerson(db, personId, v.name))) return fail(`${v.name} finns redan i listan.`);
  if ((current.role ?? null) !== v.role && !(await setPersonRole(db, personId, v.role))) return fail("Rollen kunde inte sparas. Försök igen.");
  if ((current.email ?? null) !== v.email) {
    const msg = await setEmail(db, personId, v.email);
    if (msg) return fail(msg);
  }
  refresh(orgId);
  return OK;
}

export async function removeBoardPersonAction(orgId: string, personId: string): Promise<ActionResult> {
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  const people = isUuid(personId) ? await listPeople(db, orgId) : [];
  if (!people.some((p) => p.id === personId)) return fail("Personen finns inte längre. Ladda om sidan.");
  await deletePerson(db, personId);
  refresh(orgId);
  return OK;
}

/** Step 6: records (or withdraws) that a person has said yes to having their voice learned later. */
export async function voiceConsentAction(orgId: string, personId: string, consent: boolean): Promise<ActionResult> {
  if (!isUuid(orgId) || !isUuid(personId)) return fail("Personen finns inte längre. Ladda om sidan.");
  const db = await createSupabaseServerClient();
  const people = await listPeople(db, orgId);
  if (!people.some((p) => p.id === personId)) return fail("Personen finns inte längre. Ladda om sidan.");
  const { data, error } = await db.rpc("set_voice_consent", { p_person_id: personId, p_consent: consent });
  if (error || data !== true) return fail(ADMIN_ONLY);
  refresh(orgId);
  return OK;
}

/** Step 1: the förening's name (the same rule as Inställningar). */
export async function renameOrgAction(orgId: string, name: string): Promise<ActionResult> {
  const db = await adminDb(orgId);
  if (!db) return fail(ADMIN_ONLY);
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 100) return fail("Ange ett namn på högst 100 tecken.");
  if (!(await updateOrgSettings(db, orgId, { name: clean }))) return fail(ADMIN_ONLY);
  refresh(orgId);
  return OK;
}
