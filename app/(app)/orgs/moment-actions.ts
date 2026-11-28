"use server";

import { isUuid } from "@/lib/db/ids";
import { MOMENT_CONTEXT, readMoments, type MomentLine } from "@/lib/meetings/moments";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type MomentResult = { ok: true; lines: MomentLine[] } | { ok: false };

/**
 * The transcript around one decision's or task's moment (0068), for the signed-in user only:
 * transcript_moment_lines() decides (sees the meeting as a member, the org shares its transcript,
 * not the Må-runda window). Read on click, never in the page's props.
 */
export async function transcriptMomentAction(meetingId: string, itemId: string): Promise<MomentResult> {
  if (!isUuid(meetingId) || typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(itemId)) return { ok: false };
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { ok: false };
  try {
    const lines = (await readMoments(supabaseAdmin(), user.id, meetingId, [itemId], MOMENT_CONTEXT)).get(itemId) ?? [];
    return lines.some((l) => l.source) ? { ok: true, lines } : { ok: false };
  } catch (err) {
    console.error(`moment: ${(err as Error).message}`);
    return { ok: false };
  }
}
