"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/db/ids";
import { myRole, setSummarySettings, updateOrgSettings } from "@/lib/db/orgs";
import type { SummaryMode } from "@/lib/db/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Inställningar's save-on-change controls (a switch, the summary's choices): each saves only what
// changed and returns the outcome, so the page says "Sparat" only after it worked and can roll
// back otherwise. Admins only, as the form actions they sit beside (RLS and the DB functions
// check again); updateOrgAction / updateSummaryAction stay as they were.

export type SettingResult = { ok: true } | { ok: false; message: string };

const FLAGS = ["share_transcript", "show_on_status", "require_task_fields", "invite_attendees"] as const;
export type OrgFlagName = (typeof FLAGS)[number];

async function failed(): Promise<SettingResult> {
  return { ok: false, message: (await getTranslations("org.settings"))("saveFailed") };
}

async function adminDb(orgId: string) {
  if (!isUuid(orgId)) return null;
  const db = await createSupabaseServerClient();
  return (await myRole(db, orgId)) === "admin" ? db : null;
}

/** One switch of the förening: that column only (a rename meanwhile is never overwritten). */
export async function setOrgFlagAction(orgId: string, flag: OrgFlagName, value: boolean): Promise<SettingResult> {
  if (!(FLAGS as readonly string[]).includes(flag) || typeof value !== "boolean") return failed();
  const db = await adminDb(orgId);
  if (!db) return failed();
  if (!(await updateOrgSettings(db, orgId, { [flag]: value }))) return failed();
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true };
}

const SUMMARY_MODES: SummaryMode[] = ["missed", "all", "selected", "off"];

/** "Sammanfattning efter mötet" (0037): the mode and, for "selected", the ticked people. */
export async function saveSummaryAction(orgId: string, mode: SummaryMode, personIds: string[]): Promise<SettingResult> {
  if (!SUMMARY_MODES.includes(mode) || !Array.isArray(personIds)) return failed();
  const db = await adminDb(orgId);
  if (!db) return failed();
  if (!(await setSummarySettings(db, orgId, mode, personIds.map(String).filter(isUuid)))) return failed();
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true };
}
