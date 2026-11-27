import { useTranslations } from "next-intl";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { IconUsers } from "@/components/ui/icons";
import { Panel } from "@/components/ui/Panel";
import type { OrgMember } from "@/lib/db/members";
import type { GroupRow } from "@/lib/foretag/tree";
import type { PersonRow } from "@/lib/groups/people";
import type { PeopleTreeActions } from "./PeopleTree";
import { PeopleTreeViews } from "./PeopleTreeViews";

// Inställningar → Styrelsen och medlemmar → Grupper (0054, admins): a förening may organise its
// people in the Företag's tree, opt-in. Off (the default): one panel saying so, with "Organisera i
// grupper" (the top group's name, and a confirm that says who stops seeing meetings). On: the same
// tree editor as a Företag's Personer & grupper, and "Sluta använda grupper".

export interface ForeningGroupsProps {
  org: { id: string; name: string; groups_enabled?: boolean };
  userId: string;
  groups: GroupRow[];
  people: PersonRow[];
  members: OrgMember[];
  actions: PeopleTreeActions & { setGroups: FormAction };
}

const HIDDEN = { from: "forening" };

export function ForeningGroups({ org, userId, groups, people, members, actions }: ForeningGroupsProps) {
  const t = useTranslations("foretag.groups");
  const on = org.groups_enabled === true;

  if (!on) {
    // Accounts no admin-linked person row stands for: unplaced once groups are on (they then see
    // only their own). A name a member claimed themself (0051) waits for an admin to place it.
    const linked = new Set(people.flatMap((p) => (p.member_user_id && !p.self_linked_at ? [p.member_user_id] : [])));
    const unplaced = members.filter((m) => !linked.has(m.userId)).length;
    return (
      <Panel title={t("title")} titleId="groups-title">
        <div className="flex flex-col gap-4" data-groups="off">
          <p className="max-w-[68ch] text-sm text-ink-2">{t("offIntro")}</p>
          <p className="flex items-start gap-2 text-sm text-ink-3">
            <IconUsers size={16} className="mt-[0.15rem] flex-none" />
            <span>{t("offNow")}</span>
          </p>
          <ConfirmAction
            action={actions.setGroups}
            hidden={{ orgId: org.id, on: "1" }}
            trigger={t("turnOn")}
            triggerVariant="secondary"
            title={t("turnOnTitle", { org: org.name })}
            description={
              <span className="flex flex-col gap-2">
                <span>{t("turnOnText")}</span>
                {unplaced > 0 && <span className="font-medium text-ink">{t("turnOnUnplaced", { count: unplaced })}</span>}
              </span>
            }
            confirmLabel={t("turnOn")}
            confirmVariant="primary"
            pendingLabel={t("turningOn")}
          />
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-groups="on">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="max-w-[68ch] text-sm text-ink-2">
          {t("onNow")}
        </p>
      </div>
      <PeopleTreeViews orgId={org.id} isAdmin userId={userId} groups={groups} people={people} members={members} actions={actions} hidden={HIDDEN} />
      <div className="flex justify-end">
        <ConfirmAction
          action={actions.setGroups}
          hidden={{ orgId: org.id, on: "0" }}
          trigger={t("turnOff")}
          triggerVariant="danger-quiet"
          title={t("turnOffTitle")}
          description={t("turnOffText")}
          confirmLabel={t("turnOff")}
          pendingLabel={t("turningOff")}
        />
      </div>
    </div>
  );
}
