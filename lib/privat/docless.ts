import { renderedRows, toNotesItem } from "@/lib/docs/notes";
import type { NoteItemRow } from "@/lib/db/types";
import type { NotesItem } from "@/lib/notes/schema";

// A Privat recording without a Google Doc (0045: meetings.doc_id is null). The notes engine runs
// exactly as for a Doc (same prompt, same ops, same note_items rows), only the "render" is the
// database: nobody can edit these notes by hand, so nothing is ever locked or deleted by a human,
// and the stored rows are the current state the next tick starts from. The Doc path
// (lib/docs/notes.ts renderItems) is not touched.

/** The meeting has no Google Doc: notes live in note_items only. */
export function isDocless(m: { doc_id?: string | null }): boolean {
  return !m.doc_id;
}

/** What a tick reads instead of the notes tab: the stored rows are the notes. */
export function doclessState(rows: NoteItemRow[]): {
  revisionId: string;
  text: string;
  diff: { locked: NotesItem[]; deletedIds: string[]; rows: NoteItemRow[] };
  items: NotesItem[];
} {
  const kept = rows.filter((r) => !r.deleted_by_human);
  return {
    revisionId: "db",
    // No human text: the engine's items are the whole state.
    text: "",
    diff: { locked: [], deletedIds: [], rows: kept },
    items: kept.map(toNotesItem),
  };
}

/** The rows to store after a tick: every desired item written, every other row dropped. */
export function doclessRows(meetingId: string, rows: NoteItemRow[], desired: NotesItem[]): NoteItemRow[] {
  const wanted = new Set(desired.map((i) => i.id));
  return renderedRows(meetingId, rows, desired, {
    applied: wanted,
    removed: new Set(rows.filter((r) => !wanted.has(r.id)).map((r) => r.id)),
  });
}
