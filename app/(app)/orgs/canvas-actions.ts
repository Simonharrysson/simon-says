"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/db/ids";
import { addPerson, savePeopleCanvas, setAccountManager, setManager } from "@/lib/db/foretag";
import { reconcileAfter } from "@/lib/foretag/reconcile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// The people tree (0062), called directly by the canvas, which rolls back on `{ ok: false }` (the
// list's form actions in foretag-actions.ts redirect with a notice instead). Every write runs as the
// signed-in user; the database's admin functions decide. A reporting line changes who sees what:
// Doc access and held tasks are reconciled, as for every tree change. Positions are visual only:
// no reconcile and no revalidation (a refresh mid-drag would fight the card under the pointer).

export type CanvasResult = { ok: true } | { ok: false; reason?: string };
export type ManagerTo = { manager: string } | "top" | "none";
export type Who = { personId: string } | { userId: string; name: string };

const NO: CanvasResult = { ok: false };
const validTo = (to: ManagerTo) => to === "top" || to === "none" || (typeof to === "object" && isUuid(to.manager));

function changed(orgId: string, reconcile = true): CanvasResult {
  if (reconcile) reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true };
}

/** "Rapporterar till": an arrow drawn, removed (top) or a person taken out of the tree (none). A member account without a person row gets it in the same transaction. */
export async function canvasSetManager(orgId: string, who: Who, to: ManagerTo): Promise<CanvasResult> {
  if (!isUuid(orgId) || !validTo(to)) return NO;
  const db = await createSupabaseServerClient();
  let result: string;
  if ("personId" in who) {
    if (!isUuid(who.personId) || (typeof to === "object" && to.manager === who.personId)) return NO;
    result = await setManager(db, who.personId, to);
  } else {
    if (!isUuid(who.userId)) return NO;
    result = await setAccountManager(db, orgId, who.userId, who.name, to);
  }
  if (result !== "ok") return { ok: false, reason: result };
  return changed(orgId);
}

/** "Lägg till person": name (+ e-mail, role), reporting to someone, at the top, or outside the tree. */
export async function canvasAddPerson(
  orgId: string,
  input: { name: string; role: string; email: string },
  to: ManagerTo,
  at: { x: number; y: number } | null,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!isUuid(orgId) || !validTo(to)) return { ok: false, reason: "invalid" };
  const db = await createSupabaseServerClient();
  const added = await addPerson(db, orgId, { name: input.name.trim(), role: input.role.trim(), email: input.email.trim() });
  if (!added.ok) return { ok: false, reason: added.reason };
  if (to !== "none") {
    const result = await setManager(db, added.id, to);
    if (result !== "ok") {
      changed(orgId);
      return { ok: false, reason: result };
    }
  }
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) await savePeopleCanvas(db, orgId, [{ id: added.id, x: at.x, y: at.y }]);
  changed(orgId);
  return { ok: true, id: added.id };
}

/** Name, role and e-mail of a person (admins; RLS and the 0025/0035 admin functions decide). */
export async function canvasEditPerson(orgId: string, personId: string, input: { name: string; role: string; email: string }): Promise<CanvasResult> {
  if (!isUuid(orgId) || !isUuid(personId)) return NO;
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) return NO;
  const db = await createSupabaseServerClient();
  const { data: before } = await db.from("people").select("name, role, email").eq("id", personId).eq("org_id", orgId).maybeSingle();
  if (!before) return NO;
  if (before.name !== name) {
    const { data, error } = await db.from("people").update({ name }).eq("id", personId).eq("org_id", orgId).select("id");
    if (error || !data?.length) return { ok: false, reason: error?.code === "23505" ? "duplicate" : "invalid" };
  }
  if ((before.role ?? "") !== input.role.trim()) {
    const { data } = await db.rpc("set_person_role", { p_person_id: personId, p_role: input.role.trim() });
    if (data !== true) return { ok: false, reason: "invalid" };
  }
  if ((before.email ?? "") !== input.email.trim().toLowerCase()) {
    const { data } = await db.rpc("set_person_email", { p_person_id: personId, p_email: input.email.trim() });
    if (data !== "ok") return { ok: false, reason: (data as string) ?? "invalid" };
  }
  // A new e-mail may link (or unlink) an account: who sees what can change.
  return changed(orgId);
}

/** The place of a card on the canvas (visual only). */
export async function canvasSavePositions(orgId: string, positions: { id: string; x: number; y: number }[]): Promise<CanvasResult> {
  if (!isUuid(orgId) || !Array.isArray(positions) || positions.length > 1000) return NO;
  const clean = positions.filter((p) => isUuid(p.id) && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!clean.length) return { ok: true };
  const db = await createSupabaseServerClient();
  return (await savePeopleCanvas(db, orgId, clean)) ? { ok: true } : NO;
}
