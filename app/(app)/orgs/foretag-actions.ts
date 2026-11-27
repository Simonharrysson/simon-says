"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/db/ids";
import { addPerson, archiveGroup, createForetag, placeMember, placePerson, saveGroup, setManager } from "@/lib/db/foretag";
import { canCreateForetag } from "@/lib/foretag/gate";
import { reconcileAfter } from "@/lib/foretag/reconcile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server actions for the tree: the Företag pages (0050) and a förening's Grupper (0054). Everything but the creation runs as the signed-in
// user: the database's admin functions decide (a refusal comes back as a notice code).

const field = (form: FormData, name: string) => form.get(name)?.toString() ?? "";

function orgIdFrom(form: FormData): string {
  const id = field(form, "orgId");
  if (!isUuid(id)) redirect("/foretag");
  return id;
}

/** Where a refusal comes back: a Företag's Personer & grupper, or a förening's Inställningar (`from=forening`, 0054). */
const back = (orgId: string, code?: string, form?: FormData) =>
  `/orgs/${orgId}?flik=${form && field(form, "from") === "forening" ? "installningar&del=styrelsen" : "personer"}${code ? `&fel=${code}` : ""}`;

/** The signed-in user's first name for their person row ("Simon"), else their address before @. */
function personName(user: { email?: string | null; user_metadata?: Record<string, unknown> }): string {
  const meta = user.user_metadata ?? {};
  const full = [meta.full_name, meta.name].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return (full ?? (user.email ?? "").split("@")[0] ?? "").trim().slice(0, 100);
}

/** "Skapa företag": only accounts on the allow-list until a DPA exists (lib/foretag/gate.ts). */
export async function createForetagAction(form: FormData): Promise<void> {
  const db = await createSupabaseServerClient();
  const { data } = await db.auth.getUser();
  const user = data.user;
  if (!user || !canCreateForetag(user.email)) redirect("/foretag?fel=foretag");
  const t = await getTranslations({ locale: await getLocale(), namespace: "foretag.list" });
  const result = await createForetag(user.id, field(form, "name"), t("rootName"), personName(user) || t("rootName"));
  if (!result.ok) redirect("/foretag?fel=invalid");
  // The top rail shows Företag (and marks it) from the layout: re-render it with the new company.
  revalidatePath("/", "layout");
  redirect(back(result.id));
}

/** Ny grupp, or rename / move one (hidden `groupId`). `parentId` "" = at the top. */
export async function saveGroupAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const groupId = field(form, "groupId");
  const parent = field(form, "parentId");
  const db = await createSupabaseServerClient();
  const ok = await saveGroup(db, orgId, {
    id: isUuid(groupId) ? groupId : null,
    name: field(form, "name"),
    parentId: isUuid(parent) ? parent : null,
  });
  if (!ok) redirect(back(orgId, "grupp", form));
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

export async function archiveGroupAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const groupId = field(form, "groupId");
  const db = await createSupabaseServerClient();
  if (!isUuid(groupId) || !(await archiveGroup(db, groupId))) redirect(back(orgId, "grupp-arkiv", form));
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

/** "Flytta till": a person row (`personId`) or a member account without one (`userId` + `name`). `groupId` "" = no place. */
export async function placeAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const groupId = field(form, "groupId");
  const personId = field(form, "personId");
  const userId = field(form, "userId");
  const target = isUuid(groupId) ? groupId : null;
  const db = await createSupabaseServerClient();
  const ok = isUuid(personId)
    ? await placePerson(db, personId, target)
    : isUuid(userId)
      ? await placeMember(db, orgId, userId, target, field(form, "name"))
      : false;
  if (!ok) redirect(back(orgId, "placering", form));
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

/** The list's "Rapporterar till" value: a person id, "top" or "none" (0062). */
function managerTo(value: string): { manager: string } | "top" | "none" | null {
  if (value === "top" || value === "none") return value;
  return isUuid(value) ? { manager: value } : null;
}

/**
 * The people tree's list (0062; the phone view and "Lista"): "Rapporterar till" for a person row
 * (`personId`) or a member account without one (`userId` + `name`, its row made unplaced first).
 */
export async function setManagerAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const to = managerTo(field(form, "to"));
  const personId = field(form, "personId");
  const userId = field(form, "userId");
  const db = await createSupabaseServerClient();
  let id: string | null = isUuid(personId) ? personId : null;
  if (!id && isUuid(userId)) {
    const { data } = await db.rpc("place_member", { p_org_id: orgId, p_user_id: userId, p_group_id: null, p_name: field(form, "name") });
    id = (data as string | null) ?? null;
  }
  if (!to || !id || (typeof to === "object" && to.manager === id) || !(await setManager(db, id, to))) redirect(back(orgId, "rapporterar", form));
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

/** "Lägg till person" (0062): name, e-mail and role optional, "Rapporterar till". */
export async function addTreePersonAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const to = managerTo(field(form, "to"));
  const db = await createSupabaseServerClient();
  const added = await addPerson(db, orgId, { name: field(form, "name").trim(), role: field(form, "role").trim(), email: field(form, "email").trim() });
  if (!added.ok) redirect(back(orgId, added.reason === "duplicate" ? "person-finns" : "person", form));
  if (to && to !== "none" && !(await setManager(db, added.id, to))) redirect(back(orgId, "rapporterar", form));
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

/** Rename a customer (contexts, 0045/0050; Företag admins only, the database checks it). */
export async function renameCustomerAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const customerId = field(form, "customerId");
  const name = field(form, "name").trim();
  const db = await createSupabaseServerClient();
  const href = `/orgs/${orgId}/kund/${customerId}`;
  if (!isUuid(customerId) || name.length < 1 || name.length > 80) redirect(`${href}?fel=kundnamn`);
  const { data, error } = await db.from("contexts").update({ name }).eq("id", customerId).eq("org_id", orgId).select("id");
  if (error || !data?.length) redirect(`${href}?fel=kundnamn`);
  revalidatePath(href);
}

/** Rename the company (admins; orgs_update). */
export async function renameForetagAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const name = field(form, "name").trim();
  const db = await createSupabaseServerClient();
  if (name.length < 1 || name.length > 100) redirect(`/orgs/${orgId}?flik=installningar&fel=namn`);
  const { error } = await db.from("orgs").update({ name }).eq("id", orgId);
  if (error) redirect(`/orgs/${orgId}?flik=installningar&fel=namn`);
  revalidatePath(`/orgs/${orgId}`);
}

/**
 * A förening's "Organisera i grupper" / "Sluta använda grupper" (0054, admins; the database
 * decides). On: the top group (`rootName`) and every linked person in it. Off: every member sees
 * every meeting again.
 */
export async function setGroupsAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const on = field(form, "on") === "1";
  const db = await createSupabaseServerClient();
  const t = await getTranslations({ locale: await getLocale(), namespace: "foretag.groups" });
  const rootName = field(form, "rootName").trim() || t("rootDefault");
  const { data, error } = await db.rpc("set_org_groups", { p_org_id: orgId, p_on: on, p_root_name: rootName.slice(0, 40) });
  if (error) console.error(`set_org_groups: ${error.message}`);
  if (error || data !== true) redirect(`/orgs/${orgId}?flik=installningar&del=styrelsen&fel=grupper`);
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}
