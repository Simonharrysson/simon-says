// Notes items and the operations Claude returns on them (plan, Task 8 interfaces).
// Defined here first by Task 9 (rendering); Task 8 builds the engine on the same types.

import { z } from "zod";
import type { NoteSection } from "@/lib/db/types";

export type NotesSection = NoteSection;

export interface NotesItem {
  id: string;
  section: NotesSection;
  text: string;
  owner?: string;
  due?: string;
}

export type NotesOp =
  | { op: "add"; item: NotesItem }
  | { op: "change"; id: string; text?: string; owner?: string; due?: string }
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
});
export type RawOp = z.infer<typeof RawOpSchema>;

export const OpsOutputSchema = z.object({ ops: z.array(RawOpSchema) });

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
        },
        required: ["op", "id"],
        additionalProperties: false,
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

/** RawOp → NotesOp, or null when a field the op needs is missing. Empty owner/due on `change` clears them. */
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
  if (change.text === undefined && change.owner === undefined && change.due === undefined) return null;
  return change;
}
