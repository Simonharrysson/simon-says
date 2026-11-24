// Notes items and the operations Claude returns on them (plan, Task 8 interfaces).
// Defined here first by Task 9 (rendering); Task 8 builds the engine on the same types.

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
