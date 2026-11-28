"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/db/ids";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * An admin takes a guest's access to one meeting away, or gives it back (0067,
 * set_meeting_guest_access: the database checks the admin). As the signed-in user.
 */
export async function setGuestAccessAction(form: FormData): Promise<void> {
  const orgId = form.get("orgId")?.toString() ?? "";
  const meetingId = form.get("meetingId")?.toString() ?? "";
  const userId = form.get("userId")?.toString() ?? "";
  const on = form.get("on")?.toString() === "1";
  if (!isUuid(orgId) || !isUuid(meetingId) || !isUuid(userId)) return;
  const db = await createSupabaseServerClient();
  const { error } = await db.rpc("set_meeting_guest_access", { p_meeting_id: meetingId, p_user_id: userId, p_on: on });
  if (error) console.error(`guest access: ${error.code ?? error.message}`);
  revalidatePath(`/orgs/${orgId}/mote/${meetingId}`);
}
