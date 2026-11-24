import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingEventKind } from "./types";

/** Append to the meeting's event log (tick outcomes, consent, alarms …). */
export async function logEvent(
  meetingId: string,
  kind: MeetingEventKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdmin().from("meeting_events").insert({ meeting_id: meetingId, kind, detail });
  if (error) throw new Error(`logEvent: ${error.message}`);
}
