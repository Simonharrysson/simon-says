"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { deleteMeeting } from "@/lib/db/orgs";
import { createContext, deleteContext } from "@/lib/privat/contexts-db";
import type { ContextRow } from "@/lib/privat/contexts";
import { ensurePrivatSpace } from "@/lib/privat/space";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { defaultMailer } from "@/lib/mail";
import { trySendMeetingSummaries } from "@/lib/summaries/send";
import { getEnv } from "@/lib/env";

// Server actions of the Privat pages (0045). All run as the signed-in user: RLS keeps them to
// their own space.

const field = (form: FormData, name: string) => form.get(name)?.toString() ?? "";

async function signedIn() {
  const db = await createSupabaseServerClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect("/login?next=/privat");
  return db;
}

/** "Nytt sammanhang" in the recording picker: the new (or same-named existing) context. */
export async function createContextAction(name: string): Promise<{ ok: true; context: ContextRow } | { ok: false; message: string }> {
  const db = await signedIn();
  const space = await ensurePrivatSpace(db);
  const res = await createContext(db, space, name);
  if (res.ok) {
    revalidatePath("/privat");
    return res;
  }
  const t = await getTranslations("privat.picker");
  return { ok: false, message: res.reason === "invalid" ? t("invalid") : t("failed") };
}

/** Tick a task done (or undo it) on the context or recording page. */
export async function setTaskDoneAction(taskId: string, done: boolean): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  const db = await signedIn();
  const { data, error } = await db
    .from("context_tasks")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", taskId)
    .select("context_id");
  if (error || !data?.length) {
    if (error) console.error(`privat: task tick failed: ${error.code ?? error.message}`);
    return false;
  }
  revalidatePath(`/privat/${data[0].context_id}`);
  return true;
}

/** "Radera inspelningen": the recording, its notes, transcript, summary and tasks. */
export async function deletePrivatMeetingAction(form: FormData): Promise<void> {
  const meetingId = field(form, "meetingId");
  const contextId = field(form, "contextId");
  if (!isUuid(meetingId)) redirect("/privat");
  const db = await signedIn();
  const result = await deleteMeeting(db, meetingId);
  const back = isUuid(contextId) ? `/privat/${contextId}` : "/privat";
  if (result !== "deleted") redirect(`/privat/mote/${meetingId}?fel=${result}`);
  revalidatePath(back);
  redirect(`${back}?klart=raderad`);
}

/** "Radera sammanhanget": the context and every recording in it. */
export async function deleteContextAction(form: FormData): Promise<void> {
  const contextId = field(form, "contextId");
  if (!isUuid(contextId)) redirect("/privat");
  const db = await signedIn();
  const result = await deleteContext(db, contextId);
  if (result !== "deleted") redirect(`/privat/${contextId}?fel=aktiv`);
  revalidatePath("/privat");
  redirect("/privat?klart=raderat");
}

/**
 * "Försök igen" on a recording whose summary failed: the summary (one more Claude call) or, when
 * it was written, only its e-mail, sent again now. Only the recording's own (RLS) recorder.
 */
export async function retrySummaryAction(form: FormData): Promise<void> {
  const meetingId = field(form, "meetingId");
  if (!isUuid(meetingId)) redirect("/privat");
  const db = await signedIn();
  const { data: user } = await db.auth.getUser();
  const { data: m } = await db.from("meetings").select("id, status, started_by, context_id").eq("id", meetingId).maybeSingle();
  if (!m || m.status !== "done" || !m.context_id || m.started_by !== user.user?.id) redirect(`/privat/mote/${meetingId}?fel=forbidden`);
  if (getEnv().KILL_SWITCH) redirect(`/privat/mote/${meetingId}?fel=forbidden`);
  const admin = supabaseAdmin();
  const { data: stored } = await admin.from("private_summaries").select("mailed").eq("meeting_id", meetingId).maybeSingle();
  if (stored) {
    // Written but surely not mailed: the e-mail only (never one that went or may have gone out).
    if (stored.mailed === false) {
      await admin.from("private_summaries").update({ mail_claimed_at: null, mail_attempts: 0, mailed: null }).eq("meeting_id", meetingId).eq("mailed", false);
    }
    await admin.from("meetings").update({ summary_state: "sending" }).eq("id", meetingId).neq("summary_state", "sending");
  } else {
    await admin.from("meetings").update({ summary_state: null, summary_attempts: 0, summary_lease_until: null }).eq("id", meetingId);
  }
  after(() => trySendMeetingSummaries(meetingId, { mailer: defaultMailer(), now: () => new Date() }, { deadlineAt: new Date(Date.now() + 200_000) }));
  redirect(`/privat/mote/${meetingId}?klart=nytt`);
}
