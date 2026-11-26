import { carriedItems } from "@/lib/agenda/followup";
import type { NoteItemRow } from "@/lib/db/types";
import type { RolePerson } from "@/lib/people/roles";
import type { DraftItem, FollowupOrigin } from "./types";

// Förbered möte: which meeting "Från förra veckan" draws from. Pure (the queries are in prepare.ts).
//
// An imported protocol (Översikt → läs in protokoll, 0032) counts as the previous meeting when it is
// newer than the latest real Simon Says meeting of the kind: a förening that kept its minutes in
// Google Docs until now gets last week's tasks too. Its open tasks (kind task, done not true) are
// carried as text lines: the carried rows point at the protocol (`carried_from_meeting` = protocol
// id, `carried_from_id` = `h<position>`, never a note_items id), so propagateDone finds no meeting
// and a "✓ klart" on them never reaches the imported history (by design: it is read-only).

/** How old (days before the prepared date) an imported protocol may be and still give tasks. */
export const IMPORT_MAX_DAYS = 60;

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * The source for a prepared agenda on `preparedDate`: `prev` the latest finished real meeting of
 * the kind (its local date), `protocol` the newest imported protocol on or before that date.
 * Same day: the real meeting wins.
 */
export function followupSource(input: {
  prev: { id: string; date: string } | null;
  protocol: { id: string; date: string } | null;
  preparedDate: string;
}): { use: "meeting" | "import" | null; id: string | null; origin: FollowupOrigin } {
  const { prev, protocol } = input;
  if (protocol && (!prev || protocol.date > prev.date)) {
    return days(protocol.date, input.preparedDate) <= IMPORT_MAX_DAYS
      ? { use: "import", id: protocol.id, origin: { kind: "import", date: protocol.date } }
      : { use: null, id: null, origin: { kind: "too_old", date: protocol.date } };
  }
  if (prev) return { use: "meeting", id: prev.id, origin: { kind: "meeting", date: prev.date } };
  return { use: null, id: null, origin: { kind: "none" } };
}

/** One imported protocol row (history_items). */
export interface ImportedItem {
  position: number;
  kind: string;
  text: string;
  owner: string | null;
  done: boolean | null;
}

/** The imported carried-row id for a history item: `h<position>` (note_items ids are n1, c1 …). */
export const importedId = (position: number) => `h${position}`;

/** Carried rows for the follow-up item from an imported protocol's open tasks (owner role → label as for meetings). */
export function importedCarried(
  protocolId: string,
  items: ImportedItem[],
  followupAnchor: string,
  people: RolePerson[],
  groupBy: "role" | "person" = "role",
): NoteItemRow[] {
  const open = items
    .filter((i) => i.kind === "task" && i.done !== true && i.text.trim())
    .sort((a, b) => a.position - b.position)
    .map(
      (i): NoteItemRow =>
        ({
          meeting_id: protocolId,
          id: importedId(i.position),
          section: "action",
          kind: "task",
          text: i.text.trim(),
          owner: i.owner?.trim() || null,
          due: null,
          done: false,
          locked: false,
          deleted_by_human: false,
          position: i.position,
        }) as NoteItemRow,
    );
  return carriedItems(protocolId, open, followupAnchor, people, groupBy);
}

/**
 * A prepared agenda whose "Från förra veckan" did not come from a Simon Says meeting (an imported
 * protocol was newer than the last real one, or too old to use): the start then carries nothing
 * from that older meeting either; the prepared lines are the follow-up.
 */
export function preparedSkipsMeetings(prepared: { items?: DraftItem[] | null }): boolean {
  const kind = (prepared.items ?? []).find((i) => i.role === "followup")?.origin?.kind;
  return kind === "import" || kind === "too_old";
}
