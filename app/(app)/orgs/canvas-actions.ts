"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/db/ids";
import { archiveGroup, placeMember, placePerson, saveGroup, saveGroupCanvas, setGroupHead } from "@/lib/db/foretag";
import { reconcileAfter } from "@/lib/foretag/reconcile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// The tree canvas (0055) calls these directly and rolls back on `{ ok: false }`, where the form
// actions in foretag-actions.ts redirect with a notice. Same database functions, same checks: every
// write runs as the signed-in user and the admin functions decide. Who-sees-what changes (an arrow,
// a person moved, a group archived) reconcile Doc access and held tasks, as the list editor does.
// Positions and heads are visual only: no reconcile, and positions don't revalidate the page (a
// refresh mid-drag would fight the card under the pointer).

export type CanvasResult = { ok: true } | { ok: false };
export type CreateResult = { ok: true; id: string } | { ok: false };

const NO: CanvasResult = { ok: false };

function changed(orgId: string, reconcile = true): CanvasResult {
  if (reconcile) reconcileAfter(orgId);
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true };
}

/** An arrow from `parentId` down to `groupId` (null: the arrow removed, the group at the top). */
export async function canvasSetParent(orgId: string, groupId: string, name: string, parentId: string | null): Promise<CanvasResult> {
  if (!isUuid(orgId) || !isUuid(groupId) || (parentId !== null && !isUuid(parentId)) || parentId === groupId) return NO;
  const db = await createSupabaseServerClient();
  if (!(await saveGroup(db, orgId, { id: groupId, name, parentId }))) return NO;
  return changed(orgId);
}

export async function canvasRename(orgId: string, groupId: string, name: string, parentId: string | null): Promise<CanvasResult> {
  if (!isUuid(orgId) || !isUuid(groupId) || (parentId !== null && !isUuid(parentId))) return NO;
  const db = await createSupabaseServerClient();
  if (!(await saveGroup(db, orgId, { id: groupId, name, parentId }))) return NO;
  return changed(orgId, false);
}

/** "+ Ny grupp": a top-level group (or under `parentId`), its card where it was asked for. */
export async function canvasCreate(orgId: string, name: string, parentId: string | null, at: { x: number; y: number } | null): Promise<CreateResult> {
  if (!isUuid(orgId) || (parentId !== null && !isUuid(parentId))) return { ok: false };
  const db = await createSupabaseServerClient();
  const { data, error } = await db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: name.trim(), p_parent: parentId });
  if (error && error.code !== "22023" && error.code !== "23505") throw new Error(`set_group: ${error.message}`);
  const id = typeof data === "string" ? data : null;
  if (!id) return { ok: false };
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) await saveGroupCanvas(db, orgId, [{ id, x: at.x, y: at.y }]);
  changed(orgId);
  return { ok: true, id };
}

export async function canvasArchive(orgId: string, groupId: string): Promise<CanvasResult> {
  if (!isUuid(orgId) || !isUuid(groupId)) return NO;
  const db = await createSupabaseServerClient();
  if (!(await archiveGroup(db, groupId))) return NO;
  return changed(orgId);
}

/** A person (or a member account without a person row: `userId` + `name`) dropped on a card; `groupId` null: no place. */
export async function canvasPlace(orgId: string, who: { personId: string } | { userId: string; name: string }, groupId: string | null): Promise<CanvasResult> {
  if (!isUuid(orgId) || (groupId !== null && !isUuid(groupId))) return NO;
  const db = await createSupabaseServerClient();
  const ok =
    "personId" in who
      ? isUuid(who.personId) && (await placePerson(db, who.personId, groupId))
      : isUuid(who.userId) && (await placeMember(db, orgId, who.userId, groupId, who.name));
  if (!ok) return NO;
  return changed(orgId);
}

export async function canvasSavePositions(orgId: string, positions: { id: string; x: number; y: number }[]): Promise<CanvasResult> {
  if (!isUuid(orgId) || !Array.isArray(positions) || positions.length > 500) return NO;
  const clean = positions.filter((p) => isUuid(p.id) && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!clean.length) return { ok: true };
  const db = await createSupabaseServerClient();
  return (await saveGroupCanvas(db, orgId, clean)) ? { ok: true } : NO;
}

export async function canvasSetHead(orgId: string, groupId: string, personId: string | null): Promise<CanvasResult> {
  if (!isUuid(orgId) || !isUuid(groupId) || (personId !== null && !isUuid(personId))) return NO;
  const db = await createSupabaseServerClient();
  if (!(await setGroupHead(db, groupId, personId))) return NO;
  return changed(orgId, false);
}
