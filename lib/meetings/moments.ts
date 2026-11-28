import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSpeaker, type SpeakerMapRow } from "@/lib/segments/resolve";

// The transcript behind a decision's or task's moment (0068), read through
// transcript_moment_lines(): that function holds the whole visibility rule (a member who can see
// the meeting, an org that shares its transcript, never a guest or a Privat space, never the
// Må-runda window, only segments of that meeting). Nothing here restates it. Called with the
// service role for an explicit, signed-in user id (the server action, the page loader, MCP).

/** Lines of context shown before and after the source in the transcript sheet. */
export const MOMENT_CONTEXT = 4;
/** The excerpt MCP returns per item: its source lines, at most this many characters. */
export const EXCERPT_MAX = 400;

export interface MomentLine {
  /** The speaker's name, or null when nobody named them. */
  speaker: string | null;
  text: string;
  atMs: number;
  /** One of the item's own source lines (highlighted). */
  source: boolean;
}

interface Row {
  item_id: string;
  el_session_id: string;
  segment_index: number;
  run_index: number;
  speaker: string;
  text: string;
  start_ms: number | string;
  is_source: boolean;
}

/** item id → its lines (in transcript order). An item without a returned line has no moment for this user. */
export async function readMoments(
  admin: SupabaseClient,
  userId: string,
  meetingId: string,
  itemIds: string[],
  context = 0,
): Promise<Map<string, MomentLine[]>> {
  const out = new Map<string, MomentLine[]>();
  if (!itemIds.length) return out;
  const { data, error } = await admin.rpc("transcript_moment_lines", {
    p_user: userId,
    p_meeting_id: meetingId,
    p_item_ids: itemIds,
    p_context: context,
  });
  if (error) throw new Error(`moments: ${error.message}`);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return out;
  // Names as the transcript tab shows them: through merges, a named speaker by name.
  const { data: map, error: e2 } = await admin
    .from("speaker_map")
    .select("el_session_id, speaker_label, display_name, person_id, merged_into_label")
    .eq("meeting_id", meetingId);
  if (e2) throw new Error(`moments: speakers: ${e2.message}`);
  const bySession = new Map<string, SpeakerMapRow[]>();
  for (const r of (map ?? []) as (SpeakerMapRow & { el_session_id: string })[]) bySession.set(r.el_session_id, [...(bySession.get(r.el_session_id) ?? []), r]);
  for (const r of rows) {
    const resolved = resolveSpeaker(bySession.get(r.el_session_id) ?? [], r.speaker);
    const named = resolved.displayName !== resolved.label;
    const line: MomentLine = { speaker: named ? resolved.displayName : null, text: r.text.replace(/\s+/g, " ").trim(), atMs: Number(r.start_ms), source: r.is_source };
    out.set(r.item_id, [...(out.get(r.item_id) ?? []), line]);
  }
  return out;
}

/** The excerpt of one item: its source lines, joined, cut at EXCERPT_MAX. */
export function excerpt(lines: MomentLine[]): string | null {
  const text = lines
    .filter((l) => l.source)
    .map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text))
    .join(" … ");
  if (!text) return null;
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : text;
}

/** The first source line's start: where the ▶ link points. */
export function firstSourceMs(lines: MomentLine[] | undefined): number | null {
  const first = lines?.find((l) => l.source);
  return first ? first.atMs : null;
}
