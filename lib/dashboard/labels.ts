import "server-only";
import { firstNames, safeItemLabel } from "@/lib/formats/structure";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { safeAgendaLabels, storableLabel } from "./safe-labels";

export { safeAgendaLabels };

/**
 * Store the agenda labels of a meeting's items (`ag-<n>` → label) for the org dashboard
 * (0028 `merge_agenda_labels`). Only labels that pass the format-learning filter are kept (≤ 8
 * words, no digits, no first name, full name or surname of the org's people, no
 * capitalised word after the first, which is likely a guest's name). Best effort: never throws, so a start or a
 * tick never fails on it (e.g. before 0028 is applied). Logs counts only, never a label.
 */
export async function saveAgendaLabels(meetingId: string, orgId: string, items: { key: string; label: string }[]): Promise<void> {
  if (!items.length) return;
  try {
    const admin = supabaseAdmin();
    const { data: people, error: peopleError } = await admin.from("people").select("name").eq("org_id", orgId);
    if (peopleError) throw new Error(`people: ${peopleError.message}`);
    const all = ((people ?? []) as { name: string }[]).map((p) => p.name);
    const first = firstNames(all);
    const labels = safeAgendaLabels(items, (label) => storableLabel(label, all, (l) => safeItemLabel(l, first)));
    if (!Object.keys(labels).length) return;
    const { error } = await admin.rpc("merge_agenda_labels", { p_meeting_id: meetingId, p_labels: labels });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`agenda labels ${meetingId}: not saved (${items.length} items): ${(err as Error).message}`.slice(0, 200));
  }
}
