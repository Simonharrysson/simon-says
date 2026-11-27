import type { TreePersonView } from "@/lib/groups/people";

// What the people canvas gets from the page (serializable) and what it calls back (the server
// actions in app/(app)/orgs/canvas-actions.ts, or in-memory ones on /design).

export interface CanvasData {
  orgId: string;
  isAdmin: boolean;
  people: TreePersonView[];
}

export type Ok = { ok: true } | { ok: false; reason?: string };
export type ManagerTo = { manager: string } | "top" | "none";
export type Who = { personId: string } | { userId: string; name: string };
export interface PersonInput {
  name: string;
  role: string;
  email: string;
}

export interface CanvasApi {
  setManager(orgId: string, who: Who, to: ManagerTo): Promise<Ok>;
  addPerson(orgId: string, input: PersonInput, to: ManagerTo, at: { x: number; y: number } | null): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  editPerson(orgId: string, personId: string, input: PersonInput): Promise<Ok>;
  savePositions(orgId: string, positions: { id: string; x: number; y: number }[]): Promise<Ok>;
}
