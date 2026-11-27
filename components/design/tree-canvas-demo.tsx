import { PeopleTree } from "@/components/groups/PeopleTree";
import { TreeViews } from "@/components/groups/canvas/TreeViews";
import type { CanvasApi } from "@/components/groups/canvas/types";
import type { OrgMember } from "@/lib/db/members";
import type { GroupRow } from "@/lib/foretag/tree";
import { peopleTree } from "@/lib/groups/people";

// The people tree (0062) for the /design gallery: Anna at the top, Erik and Sara reporting to her,
// their reports below, Kim on the side; every write answered in memory after a short wait.
// Fictional data.

export const treeCanvasViews = [
  { id: "foretag-canvas", title: "Företag · Personer, kartan (admin)" },
  { id: "foretag-canvas-member", title: "Företag · Personer, kartan (medlem, läsläge)" },
] as const;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { anna: id(101), erik: id(102), sara: id(103), jonas: id(104), lisa: id(105), omar: id(106), maja: id(107), kim: id(108), olle: id(109) };
const G = { top: id(1), anna: id(2), erik: id(3), sara: id(4) };
const GROUPS: GroupRow[] = [
  { id: G.top, name: "top", parent_group_id: null, depth: 0, position: 0 },
  { id: G.anna, name: "team", parent_group_id: G.top, depth: 1, position: 0, head_person_id: P.anna },
  { id: G.erik, name: "team", parent_group_id: G.anna, depth: 2, position: 0, head_person_id: P.erik },
  { id: G.sara, name: "team", parent_group_id: G.anna, depth: 2, position: 0, head_person_id: P.sara },
];
const PEOPLE = [
  { id: P.anna, name: "Anna Berg", role: "VD", member_user_id: id(201), group_id: G.top },
  { id: P.erik, name: "Erik Lund", role: "Utvecklingschef", member_user_id: id(202), group_id: G.anna },
  { id: P.sara, name: "Sara Nyström", role: "Kommunikationschef", member_user_id: id(203), group_id: G.anna },
  { id: P.jonas, name: "Jonas Ek", role: null, member_user_id: id(204), group_id: G.erik },
  { id: P.lisa, name: "Lisa Holm", role: null, member_user_id: null, group_id: G.erik },
  { id: P.omar, name: "Omar Said", role: "Designer", member_user_id: null, group_id: G.erik },
  { id: P.maja, name: "Maja Lind", role: null, member_user_id: id(207), group_id: G.sara },
  { id: P.kim, name: "Kim Ström", role: "Kassör", member_user_id: null, group_id: G.anna },
  { id: P.olle, name: "Olle Ny", role: null, member_user_id: null, group_id: null },
];
const MEMBERS: OrgMember[] = [
  { userId: id(201), email: "anna.berg@example.com", role: "admin" },
  { userId: id(202), email: "erik@example.com", role: "member" },
  { userId: id(203), email: "sara@example.com", role: "member" },
  { userId: id(204), email: "jonas@example.com", role: "member" },
  { userId: id(207), email: "maja@example.com", role: "member" },
  { userId: id(210), email: "praktikant@example.com", role: "member" },
];

const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 250));
let next = 300;
const API: CanvasApi = {
  setManager: () => wait({ ok: true }),
  addPerson: () => wait({ ok: true, id: id(next++) }),
  editPerson: () => wait({ ok: true }),
  savePositions: () => wait({ ok: true }),
};
const noop = async () => {};

function Demo({ admin }: { admin: boolean }) {
  const userId = admin ? id(201) : id(204);
  const people = peopleTree(PEOPLE, GROUPS, MEMBERS, userId);
  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 px-gutter">
      <h1 className="text-2xl font-semibold">Personer</h1>
      <TreeViews
        list={<PeopleTree orgId={id(900)} isAdmin={admin} people={people} actions={{ setManager: noop, addPerson: noop }} />}
        data={{ orgId: id(900), isAdmin: admin, people }}
        api={API}
      />
    </div>
  );
}

export const treeCanvasRender: Record<string, () => React.ReactNode> = {
  "foretag-canvas": () => <Demo admin />,
  "foretag-canvas-member": () => <Demo admin={false} />,
};
