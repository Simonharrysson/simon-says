// The people on the tree canvas (0055): every person row, plus each member account no person row
// stands for (placed through place_member, which creates the row). Same split as GroupTree's list.

import type { CanvasPerson } from "@/components/groups/canvas/types";

interface PersonRow {
  id: string;
  name: string;
  member_user_id: string | null;
  group_id: string | null;
}
interface Member {
  userId: string;
  email: string;
  role: "admin" | "member";
}

export function canvasPeople(people: PersonRow[], members: Member[], userId: string): CanvasPerson[] {
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const linked = new Set(people.flatMap((p) => (p.member_user_id ? [p.member_user_id] : [])));
  const rows: CanvasPerson[] = people.map((p) => {
    const m = p.member_user_id ? byUser.get(p.member_user_id) : undefined;
    return {
      key: `p:${p.id}`,
      personId: p.id,
      userId: p.member_user_id,
      name: p.name,
      email: m?.email ?? null,
      groupId: p.group_id,
      admin: m?.role === "admin",
      you: p.member_user_id === userId,
    };
  });
  const accounts: CanvasPerson[] = members
    .filter((m) => !linked.has(m.userId))
    .map((m) => ({ key: `u:${m.userId}`, personId: null, userId: m.userId, name: m.email, email: m.email, groupId: null, admin: m.role === "admin", you: m.userId === userId }));
  return [...rows, ...accounts];
}
