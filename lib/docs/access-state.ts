/**
 * Can this viewer open a meeting's Doc? `open`: they started it, or Simon Says shared it with
 * them (meeting_doc_shares). `request`: a Doc Simon Says created, not shared with them yet ("Få
 * åtkomst"). `ask`: the förening's own agenda Doc, which Simon Says never shares ("Be <starter>
 * dela dokumentet"). Never a link that could open Google's access-denied page. Pure.
 */
export type DocAccess = "open" | "request" | "ask";

/** Simon Says created the meeting's Doc (null before 0030: every non-agenda Doc was ours). */
export const appCreatedDoc = (m: { agenda_doc?: boolean | null; app_created_doc?: boolean | null }): boolean =>
  m.app_created_doc ?? !m.agenda_doc;

export function docAccessFor(
  meetings: { id: string; started_by: string | null; agenda_doc?: boolean | null; app_created_doc?: boolean | null }[],
  viewerId: string | null,
  sharedWithViewer: Set<string>,
): Record<string, DocAccess> {
  return Object.fromEntries(
    meetings.map((m) => [
      m.id,
      (viewerId !== null && m.started_by === viewerId) || sharedWithViewer.has(m.id) ? "open" : appCreatedDoc(m) ? "request" : "ask",
    ]),
  );
}
