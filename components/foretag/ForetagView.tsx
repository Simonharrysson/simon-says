import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconArrowRight, IconMic, IconPlus, IconRefresh, IconUsers } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NoticeBanner } from "@/components/views/NoticeBanner";
import { OrgTabsShell, type OrgTabId } from "@/components/views/OrgTabsShell";
import type { CustomerRow } from "@/lib/db/foretag";
import type { ForetagMeeting, ForetagPageData, ForetagPerson } from "@/lib/foretag/page";
import { parentChoices, seenByGroups, treeRows, type GroupRow } from "@/lib/foretag/tree";
import { formatDateTime } from "@/lib/format";
import type { Locale } from "@/lib/i18n/config";
import type { Notice } from "@/lib/ui/messages";
import { PlaceSelect } from "./PlaceSelect";

// The Företag page (0050): Möten · Kunder · Personer & grupper · Inställningar. Everything listed
// here was read with the viewer's own client, so it is exactly what RLS lets them see.

export type ForetagTab = Extract<OrgTabId, "moten" | "kunder" | "personer" | "installningar">;

export interface ForetagActions {
  saveGroup: FormAction;
  archiveGroup: FormAction;
  place: FormAction;
  rename: FormAction;
  rotateInvite: FormAction;
  setMemberRole: FormAction;
  deleteOrg: FormAction;
  leaveOrg: FormAction;
}

export interface ForetagViewProps {
  org: { id: string; name: string };
  isAdmin: boolean;
  userId: string;
  tab: ForetagTab;
  tabHref: (tab: ForetagTab) => string;
  inviteUrl: string;
  notice: Notice | null;
  data: ForetagPageData;
  actions: ForetagActions;
}

const TABS: { id: ForetagTab; adminOnly?: boolean }[] = [{ id: "moten" }, { id: "kunder" }, { id: "personer" }, { id: "installningar", adminOnly: true }];

export function ForetagView(props: ForetagViewProps) {
  const t = useTranslations("foretag");
  const tc = useTranslations("common");
  const { org, isAdmin, tab, notice } = props;
  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 px-gutter">
      <PageHeader
        title={org.name}
        back={{ href: "/foretag", label: t("list.back") }}
        meta={<p className="text-sm font-medium tracking-wide text-ink-3 uppercase">{t("kicker")}</p>}
      />
      <OrgTabsShell
        key={org.id}
        active={tab}
        label={t("tabsLabel")}
        loadingLabel={tc("loading")}
        tabs={TABS.filter((x) => isAdmin || !x.adminOnly).map((x) => ({ id: x.id, label: t(`tabs.${x.id}`), href: props.tabHref(x.id) }))}
        between={<NoticeBanner notice={notice} />}
      >
        <div className="flex flex-col gap-6">
          {tab === "moten" && <MeetingsTab {...props} />}
          {tab === "kunder" && <CustomersTab {...props} />}
          {tab === "personer" && <PeopleTab {...props} />}
          {tab === "installningar" && isAdmin && <SettingsTab {...props} />}
        </div>
      </OrgTabsShell>
    </div>
  );
}

const groupName = (groups: GroupRow[], id: string | null) => (id ? (groups.find((g) => g.id === id)?.name ?? null) : null);

function MeetingsTab({ org, isAdmin, data }: ForetagViewProps) {
  const t = useTranslations("foretag");
  const locale = useLocale() as Locale;
  const mine = groupName(data.groups, data.myGroupId);
  const done = data.meetings.filter((m) => !m.is_test);
  const customers = new Map(data.customers.map((c) => [c.id, c.name]));
  return (
    <>
      <p className="flex items-start gap-2 text-sm text-ink-2">
        <IconUsers size={16} className="mt-[0.15rem] flex-none text-ink-3" />
        <span>{isAdmin ? t("visibility.admin") : mine ? t("visibility.placed", { group: mine }) : t("visibility.unplaced")}</span>
      </p>
      {data.myLiveId ? (
        <Banner tone="info" live={false} title={t("start.activeTitle")} action={<ButtonLink href={`/meetings/${data.myLiveId}`} size="sm" variant="secondary">{t("start.toLive")}</ButtonLink>}>
          <p>{t("start.activeMine")}</p>
        </Banner>
      ) : (
        <Panel title={t("start.title")} titleId="start-title">
          <div className="flex flex-col gap-4">
            <p className="max-w-[60ch] text-sm text-ink-2">{t("start.text")}</p>
            <ButtonLink href={`/meetings/ny/${org.id}`} variant="primary" size="lg" icon={<IconMic />} className="self-start max-sm:w-full">
              {t("start.button")}
            </ButtonLink>
          </div>
        </Panel>
      )}
      {done.length === 0 ? (
        <EmptyState title={t("meetings.emptyTitle")}>
          <p>{t("meetings.emptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("meetings.title")} titleId="meetings-title">
          <ul aria-labelledby="meetings-title">
            {done.map((m) => (
              <MeetingRow key={m.id} m={m} orgId={org.id} title={data.meetingInfo[m.id]?.title ?? null} group={groupName(data.groups, m.group_id)} customer={m.context_id ? (customers.get(m.context_id) ?? null) : null} locale={locale} />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function MeetingRow({ m, orgId, title, group, customer, locale }: { m: ForetagMeeting; orgId: string; title: string | null; group: string | null; customer: string | null; locale: Locale }) {
  const t = useTranslations("foretag.meetings");
  const when = formatDateTime(m.started_at, locale);
  const running = m.status === "live" || m.status === "ending";
  return (
    <ListRow
      href={running ? `/meetings/${m.id}` : `/orgs/${orgId}/mote/${m.id}`}
      title={title ?? when}
      meta={
        <>
          {title && <>{when} · </>}
          <span className="font-medium text-ink-2">{group ?? t("whole")}</span>
          {customer && <> · {t("customer", { name: customer })}</>}
        </>
      }
      actions={
        <>
          {m.private && <Badge>{t("private")}</Badge>}
          {m.status === "live" && <Badge tone="live">{t("live")}</Badge>}
          {m.status === "ending" && <Badge tone="info">{t("ending")}</Badge>}
          {m.status === "abandoned" && <Badge>{t("abandoned")}</Badge>}
          <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
        </>
      }
    />
  );
}

function CustomersTab({ org, data }: ForetagViewProps) {
  const t = useTranslations("foretag.customers");
  const counts = new Map<string, number>();
  for (const m of data.meetings) if (m.context_id) counts.set(m.context_id, (counts.get(m.context_id) ?? 0) + 1);
  return (
    <>
      <p className="max-w-[68ch] text-sm text-ink-2">{t("intro")}</p>
      {data.customers.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          <p>{t("emptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("title")} titleId="customers-title">
          <ul aria-labelledby="customers-title">
            {data.customers.map((c: CustomerRow) => (
              <ListRow
                key={c.id}
                href={`/orgs/${org.id}/kund/${c.id}`}
                title={c.name}
                meta={
                  <>
                    {c.domain} · {t("meetings", { count: counts.get(c.id) ?? 0 })}
                  </>
                }
                actions={<IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />}
              />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function PeopleTab({ org, isAdmin, userId, data, actions }: ForetagViewProps) {
  const t = useTranslations("foretag.people");
  const ts = useTranslations("foretag.settings");
  const rows = treeRows(data.groups);
  const active = new Set(rows.map((r) => r.group.id));
  const admins = new Set(data.members.filter((m) => m.role === "admin").map((m) => m.userId));
  const linked = new Set(data.people.flatMap((p) => (p.member_user_id ? [p.member_user_id] : [])));
  const placeOptions = [{ value: "", label: t("noPlace") }, ...rows.map((r) => ({ value: r.group.id, label: `${" ".repeat(r.depth)}${r.group.name}` }))];
  const unplaced = data.people.filter((p) => !p.group_id || !active.has(p.group_id));
  const accounts = data.members.filter((m) => !linked.has(m.userId));

  const personLine = (p: ForetagPerson) => (
    <li key={p.id} className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-2 first:border-t-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-medium wrap-anywhere">{p.name}</span>
        {p.member_user_id === userId && <span className="text-sm text-ink-3">({t("you")})</span>}
        {p.member_user_id && admins.has(p.member_user_id) && <Badge tone="info">{t("admin")}</Badge>}
      </span>
      {isAdmin && (
        <PlaceSelect
          action={actions.place}
          hidden={{ orgId: org.id, personId: p.id }}
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
      <p className="max-w-[68ch] text-sm text-ink-2">
        {t("intro")} {!isAdmin && t("readOnly")}
      </p>
      <Panel title={t("title")} titleId="tree-title">
        <ol aria-labelledby="tree-title" className="flex flex-col gap-3">
          {rows.map(({ group, depth }) => {
            const members = data.people.filter((p) => p.group_id === group.id);
            const above = seenByGroups(data.groups, group);
            return (
              <li key={group.id} style={{ marginInlineStart: `${Math.min(depth, 6) * 1.25}rem` }} className="rounded-md border border-line bg-surface px-4 py-3 transition-shadow duration-150 hover:shadow-panel">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className="text-base font-semibold wrap-anywhere">{group.name}</h3>
                  <p className="text-xs text-ink-3">{above.length ? t("seenBy", { groups: above.map((g) => g.name).join(", ") }) : t("seenByAdmins")}</p>
                </div>
                {members.length ? <ul className="mt-1">{members.map(personLine)}</ul> : <p className="mt-1 text-sm text-ink-3">{t("empty")}</p>}
                {isAdmin && <GroupControls group={group} groups={data.groups} orgId={org.id} actions={actions} />}
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
                    hidden={{ orgId: org.id, userId: m.userId, name: m.email.split("@")[0] }}
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
            <input type="hidden" name="orgId" value={org.id} />
            <Field id="group-name" name="name" label={t("groupName")} required maxLength={40} className="min-w-[12rem] flex-1" />
            <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
              <Label htmlFor="group-parent">{t("under")}</Label>
              <NativeSelect id="group-parent" name="parentId" defaultValue={rows[0]?.group.id ?? ""}>
                <option value="">{t("top")}</option>
                {rows.map((r) => (
                  <option key={r.group.id} value={r.group.id}>
                    {`${" ".repeat(r.depth)}${r.group.name}`}
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

      {!isAdmin && (
        <div className="flex justify-end">
          <ConfirmAction
            action={actions.leaveOrg}
            hidden={{ orgId: org.id }}
            trigger={ts("leave")}
            triggerVariant="ghost"
            title={ts("leaveTitle", { org: org.name })}
            description={ts("leaveText")}
            confirmLabel={ts("leave")}
            pendingLabel={ts("leaving")}
          />
        </div>
      )}
    </>
  );
}

function GroupControls({ group, groups, orgId, actions }: { group: GroupRow; groups: GroupRow[]; orgId: string; actions: ForetagActions }) {
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
          <Field id={`g-${group.id}-name`} name="name" label={t("rename")} defaultValue={group.name} required maxLength={40} className="min-w-[10rem] flex-1" />
          <div className="flex min-w-[10rem] flex-1 flex-col gap-2">
            <Label htmlFor={`g-${group.id}-parent`}>{t("moveUnder")}</Label>
            <NativeSelect id={`g-${group.id}-parent`} name="parentId" defaultValue={group.parent_group_id ?? ""}>
              <option value="">{t("top")}</option>
              {parents.map((r) => (
                <option key={r.group.id} value={r.group.id}>
                  {`${" ".repeat(r.depth)}${r.group.name}`}
                </option>
              ))}
            </NativeSelect>
          </div>
          <SubmitButton variant="secondary" pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </form>
        <ConfirmAction
          action={actions.archiveGroup}
          hidden={{ orgId, groupId: group.id }}
          trigger={t("archive")}
          title={t("archiveTitle", { name: group.name })}
          description={t("archiveText")}
          confirmLabel={t("archive")}
          pendingLabel={t("archiving")}
        />
      </div>
    </details>
  );
}

function SettingsTab({ org, userId, inviteUrl, data, actions }: ForetagViewProps) {
  const t = useTranslations("foretag.settings");
  const tp = useTranslations("foretag.people");
  const names = new Map(data.people.flatMap((p) => (p.member_user_id ? [[p.member_user_id, p.name] as const] : [])));
  return (
    <>
      <Panel title={t("nameTitle")} titleId="name-title">
        <form action={actions.rename} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="orgId" value={org.id} />
          <Field id="company-name" name="name" label={t("name")} defaultValue={org.name} required maxLength={100} autoComplete="organization" className="min-w-[14rem] flex-1" />
          <SubmitButton variant="secondary" pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </form>
      </Panel>

      <Panel title={t("inviteTitle")} titleId="invite-title">
        <div className="flex flex-col gap-4">
          <p className="max-w-[60ch] text-sm text-ink-2">{t("inviteText")}</p>
          <CopyField id="invite-url" value={inviteUrl} label={t("inviteLabel")} />
          <form action={actions.rotateInvite}>
            <input type="hidden" name="orgId" value={org.id} />
            <SubmitButton variant="ghost" size="sm" icon={<IconRefresh />} pendingLabel={t("rotating")}>
              {t("rotate")}
            </SubmitButton>
          </form>
        </div>
      </Panel>

      <Panel flush title={t("adminsTitle")} titleId="admins-title">
        <p className="-mt-2 px-6 pb-4 text-sm text-ink-2">{t("adminsText")}</p>
        <ul aria-labelledby="admins-title">
          {data.members.map((m) => (
            <ListRow
              key={m.userId}
              title={names.get(m.userId) ?? m.email}
              meta={m.email}
              actions={
                m.userId === userId ? undefined : (
                  <form action={actions.setMemberRole}>
                    <input type="hidden" name="orgId" value={org.id} />
                    <input type="hidden" name="userId" value={m.userId} />
                    <input type="hidden" name="role" value={m.role === "admin" ? "member" : "admin"} />
                    <SubmitButton variant="ghost" size="sm">
                      {m.role === "admin" ? t("removeAdmin") : t("makeAdmin")}
                    </SubmitButton>
                  </form>
                )
              }
              leading={m.role === "admin" ? <Badge tone="info">{tp("admin")}</Badge> : undefined}
            />
          ))}
        </ul>
      </Panel>

      <Panel title={t("dangerTitle")} titleId="danger-title">
        <div className="flex flex-col items-start gap-4">
          <p className="max-w-[60ch] text-sm text-ink-2">{t("dangerText")}</p>
          <ConfirmAction
            action={actions.deleteOrg}
            hidden={{ orgId: org.id }}
            trigger={t("delete")}
            title={t("deleteTitle", { org: org.name })}
            confirmLabel={t("delete")}
            pendingLabel={t("deleting")}
            requireText={{ name: "confirmName", value: org.name, label: <>{t.rich("deleteType", { org: org.name, strong: (c: ReactNode) => <strong>{c}</strong> })}</> }}
          />
        </div>
      </Panel>
    </>
  );
}
