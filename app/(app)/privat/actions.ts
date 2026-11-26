"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { deleteMeeting } from "@/lib/db/orgs";
import { createContext, deleteContext } from "@/lib/privat/contexts-db";
import type { ContextRow } from "@/lib/privat/contexts";
import { ensurePrivatSpace } from "@/lib/privat/space";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  return { ok: false, message: res.reason === "invalid" ? "Skriv ett namn, till exempel en kurskod." : "Det gick inte att spara. Försök igen." };
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
