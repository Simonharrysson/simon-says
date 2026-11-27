"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/db/ids";
import { archiveGroup, createForetag, placeMember, placePerson, saveGroup } from "@/lib/db/foretag";
import { canCreateForetag } from "@/lib/foretag/gate";
import { reconcileAfter } from "@/lib/foretag/reconcile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server actions for the Företag pages (0050). Everything but the creation runs as the signed-in
// user: the database's admin functions decide (a refusal comes back as a notice code).

const field = (form: FormData, name: string) => form.get(name)?.toString() ?? "";

function orgIdFrom(form: FormData): string {
  const id = field(form, "orgId");
  if (!isUuid(id)) redirect("/orgs");
  return id;
}

const back = (orgId: string, code?: string) => `/orgs/${orgId}?flik=personer${code ? `&fel=${code}` : ""}`;

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
  if (!user || !canCreateForetag(user.email)) redirect("/orgs?fel=foretag");
  const t = await getTranslations({ locale: await getLocale(), namespace: "foretag.orgs" });
  const result = await createForetag(user.id, field(form, "name"), t("rootName"), personName(user) || t("rootName"));
  if (!result.ok) redirect("/orgs?fel=invalid");
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
  if (!ok) redirect(back(orgId, "grupp"));
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

export async function archiveGroupAction(form: FormData): Promise<void> {
  const orgId = orgIdFrom(form);
  const groupId = field(form, "groupId");
  const db = await createSupabaseServerClient();
  if (!isUuid(groupId) || !(await archiveGroup(db, groupId))) redirect(back(orgId, "grupp-arkiv"));
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
  if (!ok) redirect(back(orgId, "placering"));
  // Who can see what changed: Doc access and held tasks follow (lib/foretag/reconcile.ts).
  reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
}

/** Rename a customer (contexts, 0045/0050; members may rename, the database checks membership). */
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
