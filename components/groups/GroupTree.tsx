import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { Field } from "@/components/ui/Field";
import { IconPlus } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PlaceSelect } from "@/components/foretag/PlaceSelect";
import type { OrgMember } from "@/lib/db/members";
import { parentChoices, seenByGroups, treeRows, type GroupRow } from "@/lib/foretag/tree";

// The tree editor (Företag 0050: Personer & grupper; a förening with groups 0054: Inställningar →
// Styrelsen och medlemmar → Grupper). One component for both: the groups in tree order with who
// sees each one's meetings, everyone's place ("Flytta till …"), the people and accounts without a
// place, and a new group. Admins edit; everyone else reads. Every write is an admin function in the
// database (set_group, archive_group, set_person_group, place_member), which decides.

export interface TreePerson {
  id: string;
  name: string;
  member_user_id: string | null;
  group_id: string | null;
}

export interface GroupTreeActions {
  saveGroup: FormAction;
  archiveGroup: FormAction;
  place: FormAction;
}

export interface GroupTreeProps {
  orgId: string;
  isAdmin: boolean;
  userId: string;
  groups: GroupRow[];
  people: TreePerson[];
  members: OrgMember[];
  actions: GroupTreeActions;
  /** Hidden fields every form sends along (a förening: `from=forening`, so errors come back to Inställningar). */
  hidden?: Record<string, string>;
  /** A förening keeps at least one group while groups are on (archive_group refuses the last one): no Arkivera on it. */
  keepLastGroup?: boolean;
}

export function GroupTree({ orgId, isAdmin, userId, groups, people, members, actions, hidden = {}, keepLastGroup = false }: GroupTreeProps) {
  const t = useTranslations("foretag.people");
  const rows = treeRows(groups);
  const active = new Set(rows.map((r) => r.group.id));
  const admins = new Set(members.filter((m) => m.role === "admin").map((m) => m.userId));
  const linked = new Set(people.flatMap((p) => (p.member_user_id ? [p.member_user_id] : [])));
  const placeOptions = [{ value: "", label: t("noPlace") }, ...rows.map((r) => ({ value: r.group.id, label: `${" ".repeat(r.depth)}${r.group.name}` }))];
  const unplaced = people.filter((p) => !p.group_id || !active.has(p.group_id));
  const accounts = members.filter((m) => !linked.has(m.userId));
  const canArchive = !keepLastGroup || rows.length > 1;
  const extra = Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);

  const personLine = (p: TreePerson) => (
    <li key={p.id} className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-2 first:border-t-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-medium wrap-anywhere">{p.name}</span>
        {p.member_user_id === userId && <span className="text-sm text-ink-3">({t("you")})</span>}
        {p.member_user_id && admins.has(p.member_user_id) && <Badge tone="info">{t("admin")}</Badge>}
      </span>
      {isAdmin && (
        <PlaceSelect
          action={actions.place}
          hidden={{ ...hidden, orgId, personId: p.id }}
          value={p.group_id && active.has(p.group_id) ? p.group_id : ""}
          options={placeOptions}
          label={t("moveTo", { name: p.name })}
          savingLabel={t("moving")}
        />
      )}
    </li>
  );

  return (
    <>
      <Panel title={t("title")} titleId="tree-title">
        <ol aria-labelledby="tree-title" className="flex flex-col gap-3">
          {rows.map(({ group, depth }) => {
            const inGroup = people.filter((p) => p.group_id === group.id);
            const above = seenByGroups(groups, group);
            return (
              <li
                key={group.id}
                data-group={group.name}
                style={{ marginInlineStart: `${Math.min(depth, 6) * 1.25}rem` }}
                className="rounded-md border border-line bg-surface px-4 py-3 transition-shadow duration-150 hover:shadow-panel"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className="text-base font-semibold wrap-anywhere">{group.name}</h3>
                  <p className="text-xs text-ink-3">{above.length ? t("seenBy", { groups: above.map((g) => g.name).join(", ") }) : t("seenByAdmins")}</p>
                </div>
                {inGroup.length ? <ul className="mt-1">{inGroup.map(personLine)}</ul> : <p className="mt-1 text-sm text-ink-3">{t("empty")}</p>}
                {isAdmin && <GroupControls group={group} groups={groups} orgId={orgId} actions={actions} extra={extra} hidden={hidden} canArchive={canArchive} />}
              </li>
            );
          })}
        </ol>
      </Panel>

      {(unplaced.length > 0 || accounts.length > 0) && (
        <Panel title={t("unplacedTitle")} titleId="unplaced-title">
          <p className="-mt-2 mb-3 text-sm text-ink-2">{t("unplacedText")}</p>
          <ul aria-labelledby="unplaced-title">
            {unplaced.map(personLine)}
            {accounts.map((m) => (
              <li key={m.userId} className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-2 first:border-t-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-medium wrap-anywhere">{m.email}</span>
                  {m.userId === userId && <span className="text-sm text-ink-3">({t("you")})</span>}
                  {admins.has(m.userId) && <Badge tone="info">{t("admin")}</Badge>}
                </span>
                {isAdmin && (
                  <PlaceSelect
                    action={actions.place}
                    hidden={{ ...hidden, orgId, userId: m.userId, name: m.email.split("@")[0] }}
                    value=""
                    options={placeOptions}
                    label={t("place", { name: m.email })}
                    savingLabel={t("moving")}
                  />
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {isAdmin && (
        <Panel title={t("newGroup")} titleId="new-group-title">
          <form action={actions.saveGroup} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="orgId" value={orgId} />
            {extra}
            <Field id="group-name" name="name" label={t("groupName")} required maxLength={40} className="min-w-[12rem] flex-1" />
            <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
              <Label htmlFor="group-parent">{t("under")}</Label>
              <NativeSelect id="group-parent" name="parentId" defaultValue={rows[0]?.group.id ?? ""}>
                <option value="">{t("top")}</option>
                {rows.map((r) => (
                  <option key={r.group.id} value={r.group.id}>
                    {`${" ".repeat(r.depth)}${r.group.name}`}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <SubmitButton variant="primary" icon={<IconPlus />} pendingLabel={t("adding")} className="max-sm:w-full">
              {t("add")}
            </SubmitButton>
          </form>
        </Panel>
      )}
    </>
  );
}

function GroupControls({
  group,
  groups,
  orgId,
  actions,
  extra,
  hidden,
  canArchive,
}: {
  group: GroupRow;
  groups: GroupRow[];
  orgId: string;
  actions: GroupTreeActions;
  extra: ReactNode;
  hidden: Record<string, string>;
  canArchive: boolean;
}) {
  const t = useTranslations("foretag.people");
  const parents = treeRows(parentChoices(groups, group.id));
  return (
    <details className="group/details mt-2">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-md text-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        {t("editGroup", { name: group.name })}
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <form action={actions.saveGroup} className="flex flex-1 flex-wrap items-end gap-3">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="groupId" value={group.id} />
          {extra}
          <Field id={`g-${group.id}-name`} name="name" label={t("rename")} defaultValue={group.name} required maxLength={40} className="min-w-[10rem] flex-1" />
          <div className="flex min-w-[10rem] flex-1 flex-col gap-2">
            <Label htmlFor={`g-${group.id}-parent`}>{t("moveUnder")}</Label>
            <NativeSelect id={`g-${group.id}-parent`} name="parentId" defaultValue={group.parent_group_id ?? ""}>
              <option value="">{t("top")}</option>
              {parents.map((r) => (
                <option key={r.group.id} value={r.group.id}>
                  {`${" ".repeat(r.depth)}${r.group.name}`}
                </option>
              ))}
            </NativeSelect>
          </div>
          <SubmitButton variant="secondary" pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </form>
        {canArchive && (
          <ConfirmAction
            action={actions.archiveGroup}
            hidden={{ ...hidden, orgId, groupId: group.id }}
            trigger={t("archive")}
            title={t("archiveTitle", { name: group.name })}
            description={t("archiveText")}
            confirmLabel={t("archive")}
            pendingLabel={t("archiving")}
          />
        )}
      </div>
    </details>
  );
}
