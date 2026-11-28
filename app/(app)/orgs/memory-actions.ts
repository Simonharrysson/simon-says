"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/db/ids";
import { memberRole } from "@/lib/db/orgs";
import type { EditedLine } from "@/lib/memory/memory";
import { defaultOneShot, refreshMemory, saveMemoryEdits } from "@/lib/memory/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Inställningar → Vad Claude ska veta (0065): an admin's edits and Uppdatera. Admins only (RLS on
// org_memory checks again); never a Privat space.

export type MemoryActionResult = { ok: true; message: string } | { ok: false; message: string };

async function adminOf(orgId: string) {
  if (!isUuid(orgId)) return null;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;
  if ((await memberRole(db, orgId, user.id)) !== "admin") return null;
  const { data: org } = await db.from("orgs").select("id, name, kind").eq("id", orgId).maybeSingle();
  if (!org || org.kind === "privat") return null;
  return { db, user, org: org as { id: string; name: string; kind: string } };
}

export async function saveMemoryAction(orgId: string, edits: EditedLine[]): Promise<MemoryActionResult> {
  const t = await getTranslations("memory");
  const a = await adminOf(orgId);
  if (!a || !Array.isArray(edits)) return { ok: false, message: t("saveFailed") };
  if (!(await saveMemoryEdits(a.db, orgId, a.user.id, edits))) return { ok: false, message: t("saveFailed") };
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true, message: t("saved") };
}

export async function refreshMemoryAction(orgId: string): Promise<MemoryActionResult> {
  const t = await getTranslations("memory");
  const a = await adminOf(orgId);
  if (!a) return { ok: false, message: t("refreshFailed") };
  const result = await refreshMemory(a.db, a.org, a.user.id, { admin: supabaseAdmin(), oneShot: defaultOneShot, now: new Date() }).catch((err) => {
    console.error(`memory refresh: ${(err as Error).message}`);
    return { ok: false as const, reason: "failed" as const };
  });
  if (!result.ok) return { ok: false, message: t(`refreshReason.${result.reason}`) };
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true, message: t("refreshed", { lines: result.lines, meetings: result.meetings }) };
}
