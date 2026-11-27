import type { GroupRow } from "@/lib/foretag/tree";

// What the canvas gets from the page (serializable) and what it calls back (the server actions in
// app/(app)/orgs/canvas-actions.ts, or in-memory ones on /design).

export interface CanvasPerson {
  /** `p:<person id>` for a person row, `u:<user id>` for a member account without one. */
  key: string;
  personId: string | null;
  userId: string | null;
  name: string;
  email: string | null;
  groupId: string | null;
  admin: boolean;
  you: boolean;
}

export interface CanvasData {
  orgId: string;
  isAdmin: boolean;
  groups: GroupRow[];
  people: CanvasPerson[];
  /** A förening keeps at least one group while groups are on (0054). */
  keepLastGroup: boolean;
}

export type Ok = { ok: true } | { ok: false };

export interface CanvasApi {
  setParent(orgId: string, groupId: string, name: string, parentId: string | null): Promise<Ok>;
  rename(orgId: string, groupId: string, name: string, parentId: string | null): Promise<Ok>;
  create(orgId: string, name: string, parentId: string | null, at: { x: number; y: number } | null): Promise<{ ok: true; id: string } | { ok: false }>;
  archive(orgId: string, groupId: string): Promise<Ok>;
  place(orgId: string, who: { personId: string } | { userId: string; name: string }, groupId: string | null): Promise<Ok>;
  savePositions(orgId: string, positions: { id: string; x: number; y: number }[]): Promise<Ok>;
  setHead(orgId: string, groupId: string, personId: string | null): Promise<Ok>;
}
