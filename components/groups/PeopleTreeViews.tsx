import type { OrgMember } from "@/lib/db/members";
import type { GroupRow } from "@/lib/foretag/tree";
import { peopleTree, type PersonRow } from "@/lib/groups/people";
import { TreeViews } from "./canvas/TreeViews";
import { PeopleTree, type PeopleTreeActions } from "./PeopleTree";

// The people tree two ways (0062): the canvas on a desktop, the list (PeopleTree) on a phone and as
// "Lista". Same data, same database functions; the list's forms are the no-JS and phone path.
export function PeopleTreeViews({
  orgId,
  isAdmin,
  userId,
  groups,
  people,
  members,
  actions,
  hidden,
}: {
  orgId: string;
  isAdmin: boolean;
  userId: string;
  groups: GroupRow[];
  people: PersonRow[];
  members: OrgMember[];
  actions: PeopleTreeActions;
  hidden?: Record<string, string>;
}) {
  // Members never get a person's invite e-mail, not even in the canvas's props (only admins edit it).
  const tree = peopleTree(people, groups, members, userId).map((p) => (isAdmin || !p.personId ? p : { ...p, email: null }));
  return <TreeViews list={<PeopleTree orgId={orgId} isAdmin={isAdmin} people={tree} actions={actions} hidden={hidden} />} data={{ orgId, isAdmin, people: tree }} />;
}
