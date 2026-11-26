/**
 * Can this viewer open a meeting's Doc? `open`: they started it, or Simon Says shared it with
 * them (meeting_doc_shares). `request`: everyone else, who gets "Få åtkomst" instead of a link
 * that could open Google's access-denied page. Pure (the org page and its test).
 */
export type DocAccess = "open" | "request";

export function docAccessFor(
  meetings: { id: string; started_by: string | null }[],
  viewerId: string | null,
  sharedWithViewer: Set<string>,
): Record<string, DocAccess> {
  return Object.fromEntries(
    meetings.map((m) => [m.id, (viewerId !== null && m.started_by === viewerId) || sharedWithViewer.has(m.id) ? "open" : "request"]),
  );
}
