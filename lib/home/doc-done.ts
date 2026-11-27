import type { NoteItemRow } from "@/lib/db/types";
import { ownedSpan, type NotesTab } from "@/lib/docs/notes";
import { replaceRange, type DocsRequest } from "@/lib/google/docs";
import { hasPlaceholder, stripPlaceholders } from "@/lib/notes/tasks";

// "✓ klart" for a task ticked in the app after its meeting ended (Mina uppgifter). Pure: which
// lines to write. The same human-edit-wins rule as the tick (ownedSpan): a line is written only
// when it is still exactly what we rendered, its range covering its whole paragraph, nobody's
// suggestion on it. Otherwise the line is the human's and stays as it is.

export const DONE_MARK = "✓ klart";

export interface DocDonePlan {
  requests: DocsRequest[];
  /** Rows written, with the line now in the Doc (persist as last_rendered_text). */
  written: { id: string; text: string }[];
  /**
   * The task's own line (the primary) now says klart, or already did. False: a human edited or
   * removed it (or it was never written), so the person should tick it in the Doc too.
   */
  primaryDone: boolean;
}

const hasMark = (text: string | null | undefined) => Boolean(text && text.trimEnd().endsWith(DONE_MARK));

/** `targets`: the task's row first, then its tasks-section copies. */
export function planDocDone(tab: NotesTab, tabId: string, targets: NoteItemRow[]): DocDonePlan {
  const requests: DocsRequest[] = [];
  const written: { id: string; text: string }[] = [];
  let primaryDone = false;
  targets.forEach((row, i) => {
    let ok = false;
    const span = row.range_name ? ownedSpan(tab, row) : null;
    if (span && hasMark(span.paraText)) ok = true;
    else if (span) {
      // Done: what was still asked for ("(deadline?) – (klart när?)") no longer is.
      const line = hasPlaceholder(span.paraText) ? stripPlaceholders(span.paraText) : span.paraText;
      const text = `${line} ${DONE_MARK}`;
      requests.push(replaceRange(tabId, row.range_name!, text));
      written.push({ id: row.id, text });
      ok = true;
    }
    if (i === 0) primaryDone = ok;
  });
  return { requests, written, primaryDone };
}
