import { canvasPeople } from "@/lib/groups/people";
import { GroupTree, type GroupTreeProps } from "./GroupTree";
import { TreeViews } from "./canvas/TreeViews";

// The tree editor, two ways (0055): the canvas on a desktop, the list (GroupTree) on a phone and as
// "Lista". Same data, same database functions; the list's forms stay the no-JS and phone path.
export function GroupTreeViews(props: GroupTreeProps) {
  const { orgId, isAdmin, userId, groups, people, members, keepLastGroup = false } = props;
  return (
    <TreeViews
      list={<GroupTree {...props} />}
      data={{ orgId, isAdmin, groups, people: canvasPeople(people, members, userId), keepLastGroup }}
    />
  );
}
