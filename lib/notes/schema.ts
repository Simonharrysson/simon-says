// Notes items and the operations Claude returns on them (plan, Task 8 interfaces).
// Defined here first by Task 9 (rendering); Task 8 builds the engine on the same types.

import { z } from "zod";
import { sectionOfKind, type NoteSection } from "@/lib/db/types";

export type NotesSection = NoteSection;

export interface NotesItem {
  id: string;
  section: NotesSection;
  text: string;
  owner?: string;
  due?: string;
  /** "Klart när": the measurable result that makes the task done (0049). Set only when said. */
  doneWhen?: string;
  // Format layout (meeting formats A6). Set only when present, so v1 items keep their shape.
  /** Where the item lives: `ag-<n>`, `tasks`, `notes`, `info.<slug>`. */
  anchor?: string;
  /** A task reported done ("✓ klart"). */
  done?: boolean;
  /** This item is the tasks-section copy of item `copyOf` (id `<copyOf>-t`). */
  copyOf?: string;
  /** Carried from the previous meeting's open tasks (Från förra veckan). */
  carried?: boolean;
  /** The deadline as a day (YYYY-MM-DD), from the row's due_date (0049); marks a carried task overdue. */
  dueDate?: string;
  /** Render missing Vem/När/Klart när as visible placeholders (the space requires them, lib/notes/tasks.ts). Never stored. */
  placeholders?: boolean;
}

export type NotesOp =
  | { op: "add"; item: NotesItem }
  | {
      op: "change";
      id: string;
      text?: string;
      owner?: string;
      due?: string;
      doneWhen?: string;
      /** Agenda mode: a task reported done (Från förra veckan). Not a rewrite. */
      done?: boolean;
      /** Agenda mode: present only so validation can reject a move; an anchor change is always dropped. */
      anchor?: string;
    }
  | { op: "remove"; id: string };

// ---------------------------------------------------------------------------------------------
// What Claude returns (structured output). One flat op shape keeps the JSON schema simple for
// constrained decoding; `toNotesOp` turns it into a NotesOp and rejects incomplete ones.


export const SECTIONS = ["decision", "action", "now", "attendees"] as const;

export const RawOpSchema = z.object({
  op: z.enum(["add", "change", "remove"]),
  id: z.string().min(1),
  section: z.enum(SECTIONS).optional(),
  text: z.string().optional(),
  owner: z.string().optional(),
  due: z.string().optional(),
  done_when: z.string().optional(),
});
export type RawOp = z.infer<typeof RawOpSchema>;

export const OpsOutputSchema = z.object({ ops: z.array(RawOpSchema), title: z.string().optional() });

/** The same shape as JSON schema, for `output_config.format`. Kept byte-stable (it is part of the cached prefix). */
export const OPS_JSON_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "change", "remove"] },
          id: { type: "string" },
          section: { type: "string", enum: [...SECTIONS] },
          text: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
          done_when: { type: "string" },
        },
        required: ["op", "id"],
        additionalProperties: false,
      },
    },
    // The meeting's short title (0048): asked for in the final pass only (the tail says so).
    title: { type: "string" },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

/** RawOp → NotesOp, or null when a field the op needs is missing. Empty owner/due/done_when on `change` clears them. */
export function toNotesOp(raw: RawOp): NotesOp | null {
  const id = raw.id.trim();
  if (raw.op === "remove") return { op: "remove", id };
  if (raw.op === "add") {
    const text = raw.text?.trim();
    if (!raw.section || !text) return null;
    return {
      op: "add",
      item: {
        id,
        section: raw.section,
        text,
        ...(raw.owner?.trim() ? { owner: raw.owner.trim() } : {}),
        ...(raw.due?.trim() ? { due: raw.due.trim() } : {}),
        ...(raw.done_when?.trim() ? { doneWhen: raw.done_when.trim() } : {}),
      },
    };
  }
  const change: Extract<NotesOp, { op: "change" }> = { op: "change", id };
  if (raw.text !== undefined) {
    if (!raw.text.trim()) return null;
    change.text = raw.text.trim();
  }
  if (raw.owner !== undefined) change.owner = raw.owner.trim();
  if (raw.due !== undefined) change.due = raw.due.trim();
  if (raw.done_when !== undefined) change.doneWhen = raw.done_when.trim();
  if ([change.text, change.owner, change.due, change.doneWhen].every((v) => v === undefined)) return null;
  return change;
}

// ---------------------------------------------------------------------------------------------
// Agenda mode (meeting formats A8): Claude places items under the förening's own agenda items.
// Ops speak of kinds (decision/task/note) and anchors (`ag-<n>`, `notes`) instead of sections.

export const AGENDA_KINDS = ["decision", "task", "note"] as const;

export const RawAgendaOpSchema = z.object({
  op: z.enum(["add", "change", "remove"]),
  id: z.string().min(1),
  kind: z.enum(AGENDA_KINDS).optional(),
  anchor: z.string().optional(),
  text: z.string().optional(),
  owner: z.string().optional(),
  due: z.string().optional(),
  done_when: z.string().optional(),
  done: z.boolean().optional(),
});
export type RawAgendaOp = z.infer<typeof RawAgendaOpSchema>;

export const AgendaOpsOutputSchema = z.object({ ops: z.array(RawAgendaOpSchema), title: z.string().optional() });

/** The same shape as JSON schema, for `output_config.format`. Kept byte-stable (it is part of the cached prefix). */
export const AGENDA_OPS_JSON_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "change", "remove"] },
          id: { type: "string" },
          kind: { type: "string", enum: [...AGENDA_KINDS] },
          anchor: { type: "string" },
          text: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
          done_when: { type: "string" },
          done: { type: "boolean" },
        },
        required: ["op", "id"],
        additionalProperties: false,
      },
    },
    // The meeting's short title (0048): asked for in the final pass only (the tail says so).
    title: { type: "string" },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

/**
 * RawAgendaOp → NotesOp, or null when a field the op needs is missing. `add` needs kind and text
 * (kind → section via `sectionOfKind`; the anchor is copied onto the item and checked by
 * `applyOps`). `change` keeps `done` and `anchor` so `applyOps` can accept a done report and reject
 * a move. Empty owner/due/done_when on `change` clears them.
 */
export function toAgendaOp(raw: RawAgendaOp): NotesOp | null {
  const id = raw.id.trim();
  if (raw.op === "remove") return { op: "remove", id };
  const anchor = raw.anchor?.trim();
  if (raw.op === "add") {
    const text = raw.text?.trim();
    if (!raw.kind || !text) return null;
    return {
      op: "add",
      item: {
        id,
        section: sectionOfKind(raw.kind),
        text,
        ...(raw.owner?.trim() ? { owner: raw.owner.trim() } : {}),
        ...(raw.due?.trim() ? { due: raw.due.trim() } : {}),
        ...(raw.done_when?.trim() ? { doneWhen: raw.done_when.trim() } : {}),
        ...(anchor ? { anchor } : {}),
      },
    };
  }
  const change: Extract<NotesOp, { op: "change" }> = { op: "change", id };
  if (raw.text !== undefined) {
    if (!raw.text.trim()) return null;
    change.text = raw.text.trim();
  }
  if (raw.owner !== undefined) change.owner = raw.owner.trim();
  if (raw.due !== undefined) change.due = raw.due.trim();
  if (raw.done_when !== undefined) change.doneWhen = raw.done_when.trim();
  if (raw.done !== undefined) change.done = raw.done;
  if (anchor) change.anchor = anchor;
  const changes = [change.text, change.owner, change.due, change.doneWhen, change.done, change.anchor].some((v) => v !== undefined);
  return changes ? change : null;
}
