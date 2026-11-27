import "server-only";
import { logEvent } from "@/lib/db/events";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canResume, RESUME_WINDOW_MS } from "@/lib/ui/meetings";

export { canResume, RESUME_WINDOW_MS };

export type ResumeResult = "live" | "resumed" | "too_old" | "not_resumable" | "org_busy" | "not_found";

/**
 * "Fortsätt mötet" (the caller checked the user is a member of the förening). A live meeting just continues
 * (`live`). An abandoned one ended < 2 h ago goes back to live (`resumed`): end fields cleared
 * and a fresh heartbeat, so the abandon sweep doesn't end it again at once; the next tick puts
 * the LIVE header back. Refused while another meeting of the org is running. Segments and notes
 * from before are kept; new ElevenLabs sessions get new keys, so nothing is overwritten.
 */
export async function resumeMeeting(meetingId: string, now = new Date()): Promise<ResumeResult> {
  const db = supabaseAdmin();
  const { data: m, error } = await db
    .from("meetings")
    .select("id, org_id, status, ended_at")
    .eq("id", meetingId)
    .maybeSingle();
  if (error) throw new Error(`resume: read: ${error.message}`);
  if (!m) return "not_found";
  if (m.status === "live") return "live";
  if (m.status !== "abandoned") return "not_resumable";
  if (!canResume(m, now.getTime())) return "too_old";

  const { data: others, error: oe } = await db
    .from("meetings")
    .select("id")
    .eq("org_id", m.org_id)
    .in("status", ["live", "ending"])
    .neq("id", meetingId)
    .limit(1);
  if (oe) throw new Error(`resume: org: ${oe.message}`);
  if (others?.length) return "org_busy";

  const cutoff = new Date(now.getTime() - RESUME_WINDOW_MS).toISOString();
  const { data: updated, error: ue } = await db
    .from("meetings")
    .update({
      status: "live",
      ended_at: null,
      end_status: null,
      end_attempts: 0,
      end_lease_until: null,
      // The Avsluta answers belonged to the end that was undone (0049): the next end asks again.
      task_answers: null,
      last_heartbeat_at: now.toISOString(),
    })
    .eq("id", meetingId)
    .eq("status", "abandoned")
    .gt("ended_at", cutoff)
    .select("id");
  if (ue) throw new Error(`resume: update: ${ue.message}`);
  if (!updated?.length) return "not_resumable";
  await logEvent(meetingId, "resumed", { from: "abandoned" }).catch((e: Error) => console.error(`resume: logEvent: ${e.message}`));
  return "resumed";
}
