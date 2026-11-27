import { GroupTree } from "@/components/groups/GroupTree";
import { TreeViews } from "@/components/groups/canvas/TreeViews";
import type { CanvasApi } from "@/components/groups/canvas/types";
import type { OrgMember } from "@/lib/db/members";
import type { GroupRow } from "@/lib/foretag/tree";
import { canvasPeople } from "@/lib/groups/people";

// The tree canvas (0055) for the /design gallery: the spec's company (VD → Ledning → Utveckling,
// Kommunikation, Ekonomi), every write answered in memory after a short wait. Fictional data.

export const treeCanvasViews = [
  { id: "foretag-canvas", title: "Företag · Personer & grupper, kartan (admin)" },
  { id: "foretag-canvas-member", title: "Företag · Personer & grupper, kartan (medlem, läsläge)" },
] as const;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const G = { vd: id(1), led: id(2), dev: id(3), com: id(4), eko: id(5) };
const GROUPS: GroupRow[] = [
  { id: G.vd, name: "VD", parent_group_id: null, depth: 0, position: 0 },
  { id: G.led, name: "Ledning", parent_group_id: G.vd, depth: 1, position: 0 },
  { id: G.dev, name: "Utveckling", parent_group_id: G.led, depth: 2, position: 0, head_person_id: id(102) },
  { id: G.com, name: "Kommunikation", parent_group_id: G.led, depth: 2, position: 1, head_person_id: id(103) },
  { id: G.eko, name: "Ekonomi", parent_group_id: null, depth: 0, position: 1 },
];
const PEOPLE = [
  { id: id(101), name: "Anna Berg", member_user_id: id(201), group_id: G.vd },
  { id: id(102), name: "Erik Lund", member_user_id: id(202), group_id: G.led },
  { id: id(103), name: "Sara Nyström", member_user_id: id(203), group_id: G.led },
  { id: id(104), name: "Jonas Ek", member_user_id: id(204), group_id: G.dev },
  { id: id(105), name: "Lisa Holm", member_user_id: null, group_id: G.dev },
  { id: id(106), name: "Omar Said", member_user_id: null, group_id: G.dev },
  { id: id(107), name: "Maja Lind", member_user_id: id(207), group_id: G.com },
  { id: id(108), name: "Kim Ström", member_user_id: null, group_id: G.eko },
  { id: id(109), name: "Olle Ny", member_user_id: null, group_id: null },
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
  setParent: () => wait({ ok: true }),
  rename: () => wait({ ok: true }),
  create: () => wait({ ok: true, id: id(next++) }),
  archive: () => wait({ ok: true }),
  place: () => wait({ ok: true }),
  savePositions: () => wait({ ok: true }),
  setHead: () => wait({ ok: true }),
};
const noop = async () => {};

function Demo({ admin }: { admin: boolean }) {
  const userId = admin ? id(201) : id(204);
  const props = { orgId: id(900), isAdmin: admin, userId, groups: GROUPS, people: PEOPLE, members: MEMBERS, actions: { saveGroup: noop, archiveGroup: noop, place: noop } };
  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 px-gutter">
      <h1 className="text-2xl font-semibold">Personer & grupper</h1>
      <TreeViews list={<GroupTree {...props} />} data={{ orgId: props.orgId, isAdmin: admin, groups: GROUPS, people: canvasPeople(PEOPLE, MEMBERS, userId), keepLastGroup: false }} api={API} />
    </div>
  );
}

export const treeCanvasRender: Record<string, () => React.ReactNode> = {
  "foretag-canvas": () => <Demo admin />,
  "foretag-canvas-member": () => <Demo admin={false} />,
};
