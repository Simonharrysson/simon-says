import type { ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight, IconExternal, IconMic, IconPlay, IconPlus, IconRefresh, IconStop, IconTrash } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { MeetingStatus } from "@/lib/db/types";
import { formatDateTime, formatDuration, formatMeetingDate } from "@/lib/format";
import { canEndFromOrgPage } from "@/lib/meetings/access";
import { canResume, docUrl, meetingDeleteState } from "@/lib/ui/meetings";
import type { Notice } from "@/lib/ui/messages";
import { DocAccessButton } from "./DocAccessButton";
import { NoticeBanner } from "./NoticeBanner";
import type { DocAccess } from "@/lib/docs/access-state";
import { OrgSettingsForm } from "./OrgSettingsForm";
import { PersonRow } from "./PersonRow";
import { OrgLogo } from "@/components/onboarding/OrgLogo";
import type { OrgProfile } from "@/lib/orgs/profile";
import { OrgAbout } from "./OrgAbout";

export interface OrgDetailMeeting {
  id: string;
  status: MeetingStatus;
  started_at: string;
  ended_at: string | null;
  doc_id: string;
  started_by: string | null;
}

export interface OrgDetailViewProps {
  /** `about` and the links (0044, todo #13) show in the header when set. */
  org: { id: string; name: string; share_transcript: boolean; show_on_status: boolean } & Partial<OrgProfile>;
  isAdmin: boolean;
  userId: string | null;
  inviteUrl: string;
  /** Members (email, role), oldest first. Omitted when unavailable. */
  members?: { userId: string; email: string; role: "admin" | "member" }[];
  people: { id: string; name: string; role?: string | null; email?: string | null; member_user_id?: string | null }[];
  meetings: OrgDetailMeeting[];
  /** The förening's logo (0035), shown next to its name; null: the first letter. */
  logoUrl?: string | null;
  /** The "Kom igång" card (admins, onboarding not done), above everything else. */
  komIgang?: ReactNode;
  /** The viewer's sign-in address: meeting Docs are shared to it. */
  viewerEmail?: string | null;
  /** Per meeting id; a meeting not in the map is `open` (e.g. the /design gallery). */
  docAccess?: Record<string, DocAccess>;
  notice: Notice | null;
  /** The "Starta möte" form, shown while no meeting is running. Omitted: no start panel. */
  startMeeting?: ReactNode;
  /** Link to start a meeting (Task 7). Hidden until the live page exists. */
  startMeetingHref?: string;
  /** Admins: "Bjud in via mejl" (`InviteByEmail`), in the Bjud in panel under the link. */
  inviteByEmail?: ReactNode;
  /** The meeting-format card (`FormatCard`), shown above the people panel. */
  formatCard?: ReactNode;
  /** Admins: "Sammanfattning efter mötet" (`SummarySettingsForm`, 0037), in Inställningar. */
  summarySettings?: ReactNode;
  /** Admins: "Om oss" (`OrgProfileForm`, 0044), in Inställningar. */
  profileSettings?: ReactNode;
  /**
   * Link into a meeting's live page (Task 7), e.g. id => `/meetings/${id}`. Any member may
   * continue a running meeting (and one abandoned < 2 h ago) there. Hidden when absent.
   */
  liveMeetingHref?: (meetingId: string) => string;
  /**
   * The "Översikt" tab (org dashboard): when given, a tab bar shows under the header and
   * `active === "oversikt"` renders `overview` instead of the meetings page; `href` builds the links.
   */
  tabs?: { active: OrgTab; href: (tab: OrgTab) => string; overview?: ReactNode };
  actions: {
    rotateInvite: FormAction;
    addPerson: FormAction;
    renamePerson: FormAction;
    /** Admins: set or clear a person's role (hidden `orgId`, `personId`, field `role`). */
    setPersonRole?: FormAction;
    deletePerson: FormAction;
    deleteMeeting: FormAction;
    /** Admins and the starter: end a live meeting (hidden `orgId`, `meetingId`). */
    endMeeting?: FormAction;
    updateOrg: FormAction;
    deleteOrg: FormAction;
    /** Admins: remove a member (hidden `orgId`, `userId`). */
    removeMember?: FormAction;
    /** Leave the org yourself (hidden `orgId`). */
    leaveOrg?: FormAction;
    /** Admins: make a member admin or take admin away (hidden `orgId`, `userId`, `role` = admin | member). */
    setMemberRole?: FormAction;
  };
}

/**
 * One row of the members panel. Admins can make others admin or take it away, and remove
 * members; everyone can leave. The last admin is offered neither stepping down nor leaving
 * (the DB refuses both too, migration 0031): the row says what to do instead.
 */
function MemberRow({
  member: m,
  me,
  org,
  isAdmin,
  adminCount,
  memberCount,
  actions,
}: {
  member: { userId: string; email: string; role: "admin" | "member" };
  me: boolean;
  org: { id: string; name: string };
  isAdmin: boolean;
  adminCount: number;
  memberCount: number;
  actions: OrgDetailViewProps["actions"];
}) {
  const t = useTranslations("org");
  const label = m.email || t("unknownMember");
  const lastAdmin = m.role === "admin" && adminCount <= 1;
  const roleForm = (role: "admin" | "member") => ({ orgId: org.id, userId: m.userId, role });

  let controls: ReactNode = null;
  if (me) {
    controls = lastAdmin ? (
      memberCount > 1 && <span className="text-sm text-ink-3">{t("lastAdminLeave")}</span>
    ) : (
      <>
        {isAdmin && actions.setMemberRole && (
          <ConfirmAction
            action={actions.setMemberRole}
            hidden={roleForm("member")}
            trigger={t("stepDown")}
            triggerVariant="ghost"
            title={t("stepDownTitle", { org: org.name })}
            description={t("stepDownText")}
            confirmLabel={t("stepDown")}
            pendingLabel={t("saving")}
            confirmVariant="primary"
          />
        )}
        {actions.leaveOrg && (
          <ConfirmAction
            action={actions.leaveOrg}
            hidden={{ orgId: org.id }}
            trigger={t("leave")}
            triggerVariant="ghost"
            title={t("leaveTitle", { org: org.name })}
            description={t("leaveText")}
            confirmLabel={t("leaveConfirm")}
            pendingLabel={t("leaving")}
          />
        )}
      </>
    );
  } else if (isAdmin) {
    controls = (
      <>
        {actions.setMemberRole &&
          (m.role === "member" ? (
            <ConfirmAction
              action={actions.setMemberRole}
              hidden={roleForm("admin")}
              trigger={t("makeAdmin")}
              triggerVariant="ghost"
              title={t("makeAdminTitle", { name: label })}
              description={t("makeAdminText")}
              confirmLabel={t("makeAdmin")}
              pendingLabel={t("saving")}
              confirmVariant="primary"
            />
          ) : (
            <ConfirmAction
              action={actions.setMemberRole}
              hidden={roleForm("member")}
              trigger={t("removeAdmin")}
              triggerVariant="ghost"
              title={t("removeAdminTitle", { name: label })}
              description={t("removeAdminText")}
              confirmLabel={t("removeAdmin")}
              pendingLabel={t("saving")}
              confirmVariant="primary"
            />
          ))}
        {actions.removeMember && (
          <ConfirmAction
            action={actions.removeMember}
            hidden={{ orgId: org.id, userId: m.userId }}
            trigger={t("remove")}
            triggerVariant="ghost"
            title={t("removeTitle", { name: label })}
            description={t("removeText")}
            confirmLabel={t("removeConfirm")}
            pendingLabel={t("removing")}
          />
        )}
      </>
    );
  }

  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-6 [li:first-child>&]:border-t-0 min-h-11 py-2">
        <span className="flex min-w-0 flex-1 basis-48 flex-col gap-[0.1rem]">
          <span className="text-sm font-medium wrap-anywhere">{label}</span>
          {(m.role === "admin" || me) && (
            <span className="text-sm text-ink-3">{[m.role === "admin" ? t("roleAdmin") : null, me ? t("roleYou") : null].filter(Boolean).join(" · ")}</span>
          )}
        </span>
        {controls && <div className="ml-auto flex flex-wrap items-center justify-end gap-1">{controls}</div>}
      </div>
    </li>
  );
}

export type OrgTab = "moten" | "oversikt";
const TABS: { id: OrgTab; label: "tabMeetings" | "tabOverview" }[] = [
  { id: "moten", label: "tabMeetings" },
  { id: "oversikt", label: "tabOverview" },
];

/** Server-rendered tabs: links with aria-current, so the URL can be shared and reloaded. */
function OrgTabs({ active, href }: { active: OrgTab; href: (tab: OrgTab) => string }) {
  const t = useTranslations("org");
  return (
    <nav aria-label={t("tabsLabel")} className="-mt-2 flex gap-1 border-b border-line">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={href(tab.id)}
          aria-current={tab.id === active ? "page" : undefined}
          className="-mb-px inline-flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-ink-3 no-underline transition-colors duration-120 hover:text-ink aria-[current=page]:border-ink aria-[current=page]:text-ink max-md:min-h-11"
        >
          {t(tab.label)}
        </Link>
      ))}
    </nav>
  );
}

const statusTone: Record<MeetingStatus, BadgeTone> = {
  live: "live",
  ending: "neutral",
  done: "success",
  abandoned: "neutral",
};

export function OrgDetailView(props: OrgDetailViewProps) {
  const { org, isAdmin, userId, inviteUrl, members, people, meetings, docAccess, viewerEmail, notice, startMeeting, startMeetingHref, formatCard, summarySettings, profileSettings, liveMeetingHref, tabs, actions, logoUrl, komIgang, inviteByEmail } = props;
  const t = useTranslations("org");
  const access = (m: OrgDetailMeeting): DocAccess => docAccess?.[m.id] ?? "open";
  const starter = (m: OrgDetailMeeting) => members?.find((x) => x.userId === m.started_by)?.email || t("starterFallback");
  const active = meetings.find((m) => m.status === "live" || m.status === "ending");
  // Any member may continue the running meeting from their own device (Meet-like presence).
  const running = liveMeetingHref && active?.status === "live" && userId !== null ? active : null;
  const nameError = notice?.code === "namn" ? notice.text : undefined;

  return (
    <div className="mx-auto w-full max-w-page px-gutter flex flex-col gap-6">
      <PageHeader
        back={{ href: "/orgs", label: t("back") }}
        title={
          <span className="flex items-center gap-4">
            <OrgLogo name={org.name} src={logoUrl} size="md" />
            <span className="min-w-0">{org.name}</span>
          </span>
        }
        meta={
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={isAdmin ? "info" : "neutral"}>{isAdmin ? t("youAreAdmin") : t("youAreMember")}</Badge>
              <span className="text-sm text-ink-3">{t("counts", { people: people.length, meetings: meetings.length })}</span>
            </div>
            <OrgAbout profile={org} />
          </div>
        }
        actions={
          running && liveMeetingHref ? (
            <ButtonLink href={liveMeetingHref(running.id)} variant="primary" size="lg" icon={<IconPlay size={18} />}>
              {t("resume")}
            </ButtonLink>
          ) : (
            startMeetingHref && (
              <ButtonLink href={startMeetingHref} variant="primary" size="lg" icon={<IconMic />}>
                {t("startMeeting")}
              </ButtonLink>
            )
          )
        }
      />
      {tabs && <OrgTabs active={tabs.active} href={tabs.href} />}
      <NoticeBanner notice={notice} />
      {komIgang}

      {tabs?.active === "oversikt" ? (
        tabs.overview
      ) : (
      <>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          {active ? (
            <Banner tone="info" title={t("activeTitle")} live={false}>
              {access(active) !== "open" && active.started_by !== userId ? (
                <div className="flex flex-col items-start gap-2">
                  <p>
                    {t("activeText")}
                    {active.status === "live" && t("activeAutoEnd")}
                  </p>
                  <DocAccessButton
                    meetingId={active.id}
                    docHref={docUrl(active.doc_id)}
                    starter={starter(active)}
                    email={viewerEmail}
                    askOnly={access(active) === "ask"}
                  />
                </div>
              ) : (
                <p>
                  {t.rich("activeTextLink", {
                    link: (chunks) => (
                      <a href={docUrl(active.doc_id)} target="_blank" rel="noopener noreferrer">
                        {chunks}
                      </a>
                    ),
                  })}
                  {active.status === "live" && t("activeAutoEnd")}
                </p>
              )}
            </Banner>
          ) : (
            startMeeting && (
              <Panel title={t("startPanel")} titleId="start-title">
                {startMeeting}
              </Panel>
            )
          )}
          <MeetingsPanel
            meetings={meetings}
            orgId={org.id}
            isAdmin={isAdmin}
            userId={userId}
            viewerEmail={viewerEmail}
            access={access}
            starter={starter}
            deleteMeeting={actions.deleteMeeting}
            endMeeting={actions.endMeeting}
            liveMeetingHref={liveMeetingHref}
          />
          {formatCard}
          <PeoplePanel orgId={org.id} people={people} members={members} isAdmin={isAdmin} actions={actions} />
        </div>

        <div className="flex flex-col gap-6">
          <Panel title={t("inviteTitle")} titleId="invite-title">
            <div className="flex flex-col gap-3">
              {inviteByEmail && (
                <section aria-labelledby="invite-email-title" className="flex flex-col gap-3 border-b border-line pb-5">
                  <h3 id="invite-email-title" className="text-sm font-semibold">
                    {t("inviteByEmail")}
                  </h3>
                  {inviteByEmail}
                </section>
              )}
              <p className="text-sm text-ink-3">
                {inviteByEmail ? t("orShareLink") : ""}
                {t("inviteLinkText")}
              </p>
              <CopyField id="invite-url" value={inviteUrl} label={t("inviteLinkLabel")} />
              {isAdmin && (
                <div>
                  <ConfirmAction
                    action={actions.rotateInvite}
                    hidden={{ orgId: org.id }}
                    trigger={t("newLink")}
                    triggerVariant="ghost"
                    triggerIcon={<IconRefresh size={18} />}
                    title={t("newLinkTitle")}
                    description={t("newLinkText")}
                    confirmLabel={t("newLink")}
                    confirmVariant="primary"
                    pendingLabel={t("creating")}
                  />
                </div>
              )}
            </div>
          </Panel>

          {members && (
            <Panel flush title={t("membersTitle")} titleId="members-title" actions={<span className="text-sm text-ink-3">{members.length}</span>}>
              <p className="text-sm text-ink-3 -mt-2 px-6 pb-4">{t("membersText")}</p>
              <ul aria-labelledby="members-title">
                {members.map((m) => (
                  <MemberRow
                    key={m.userId}
                    member={m}
                    me={userId !== null && m.userId === userId}
                    org={org}
                    isAdmin={isAdmin}
                    adminCount={members.filter((x) => x.role === "admin").length}
                    memberCount={members.length}
                    actions={actions}
                  />
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {isAdmin && (
        <>
          <Panel title={t("settingsTitle")} titleId="settings-title" id="installningar">
            <OrgSettingsForm org={org} updateOrg={actions.updateOrg} nameError={nameError} />
            {profileSettings && (
              <div id="om-oss" className="mt-6 scroll-mt-6 border-t border-line pt-6">
                {profileSettings}
              </div>
            )}
            {summarySettings && (
              <div id="sammanfattning" className="mt-6 scroll-mt-6 border-t border-line pt-6">
                {summarySettings}
              </div>
            )}
            <p className="mt-6 border-t border-line pt-4 text-sm text-ink-3">
              {t.rich("settingsMore", { link: (chunks) => <a href={`/orgs/${org.id}/kom-igang`}>{chunks}</a> })}
            </p>
          </Panel>

          <Panel title={t("deleteOrgTitle")} titleId="danger-title" className="shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_40%,var(--line))]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-ink-3 max-w-[68ch]">{t("deleteOrgText")}</p>
              <ConfirmAction
                action={actions.deleteOrg}
                hidden={{ orgId: org.id }}
                trigger={t("deleteOrg")}
                triggerVariant="danger"
                triggerSize="md"
                triggerIcon={<IconTrash size={18} />}
                title={t("deleteOrgConfirmTitle", { org: org.name })}
                description={t("deleteOrgConfirmText")}
                requireText={{
                  name: "confirmName",
                  value: org.name,
                  label: <>{t.rich("deleteOrgType", { org: org.name, strong: (chunks) => <strong>{chunks}</strong> })}</>,
                }}
                confirmLabel={t("deleteForever")}
                pendingLabel={t("deleting")}
              />
            </div>
          </Panel>
        </>
      )}
      </>
      )}
    </div>
  );
}

function MeetingsPanel({
  meetings,
  orgId,
  isAdmin,
  userId,
  deleteMeeting,
  endMeeting,
  liveMeetingHref,
  access,
  starter,
  viewerEmail,
}: {
  viewerEmail?: string | null;
  access: (m: OrgDetailMeeting) => DocAccess;
  starter: (m: OrgDetailMeeting) => string;
  meetings: OrgDetailMeeting[];
  orgId: string;
  isAdmin: boolean;
  userId: string | null;
  deleteMeeting: FormAction;
  endMeeting?: FormAction;
  liveMeetingHref?: (meetingId: string) => string;
}) {
  const t = useTranslations("org");
  const common = useTranslations("common");
  const locale = useLocale();
  return (
    <Panel flush title={t("meetingsTitle")} titleId="meetings-title">
      {meetings.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title={t("noMeetingsTitle")}>
            <p>{t("noMeetingsText")}</p>
          </EmptyState>
        </div>
      ) : (
        <>
          <ul  aria-labelledby="meetings-title">
            {meetings.map((meeting) => {
              const state = meetingDeleteState(meeting, { isAdmin, userId });
              const mine = userId !== null && meeting.started_by === userId;
              const duration =
                meeting.ended_at &&
                formatDuration((new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 1000, locale);
              return (
                <li key={meeting.id} id={`mote-${meeting.id}`} className="scroll-mt-6">
                  <div className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0 max-[30rem]:flex-wrap">
                    <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
                      <span className="font-medium wrap-anywhere">{formatMeetingDate(meeting.started_at, undefined, locale)}</span>
                      <span className="mt-[0.15rem] flex flex-wrap items-center gap-2 text-xs text-ink-3">
                        <Badge tone={statusTone[meeting.status]}>{t(`status.${meeting.status}`)}</Badge>
                        {duration && <span>{duration}</span>}
                        {state === "active" && <span>{t("endBeforeDelete")}</span>}
                      </span>
                    </span>
                    <span className="flex flex-none items-center gap-1 max-[30rem]:w-full">
                      {meeting.status === "live" && userId !== null && liveMeetingHref && (
                        <ButtonLink href={liveMeetingHref(meeting.id)} variant="primary" size="sm" icon={<IconArrowRight size={16} />}>
                          {t("toMeeting")}
                        </ButtonLink>
                      )}
                      {meeting.status === "live" && endMeeting && canEndFromOrgPage(isAdmin ? "admin" : "member", mine) && (
                        <ConfirmAction
                          action={endMeeting}
                          hidden={{ orgId, meetingId: meeting.id }}
                          trigger={t("endMeeting")}
                          triggerIcon={<IconStop size={16} />}
                          triggerVariant="ghost"
                          title={t("endMeetingTitle")}
                          description={t("endMeetingText")}
                          confirmLabel={t("endMeeting")}
                          pendingLabel={t("ending")}
                        />
                      )}
                      {meeting.status === "abandoned" && userId !== null && liveMeetingHref && canResume(meeting) && (
                        <ButtonLink href={liveMeetingHref(meeting.id)} size="sm" icon={<IconPlay size={16} />}>
                          {t("resume")}
                        </ButtonLink>
                      )}
                      {access(meeting) !== "open" && !mine ? (
                        <DocAccessButton
                          meetingId={meeting.id}
                          docHref={docUrl(meeting.doc_id)}
                          starter={starter(meeting)}
                          email={viewerEmail}
                          askOnly={access(meeting) === "ask"}
                        />
                      ) : (
                        <a
                          className={buttonVariants({ size: "sm" })}
                          href={docUrl(meeting.doc_id)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("document")}
                          <IconExternal size={16} />
                          <span className="sr-only">{common("opensInNewTab")}</span>
                        </a>
                      )}
                      {state === "allowed" && (
                        <ConfirmAction
                          action={deleteMeeting}
                          hidden={{ orgId, meetingId: meeting.id }}
                          trigger={t("deleteMeeting", { date: formatDateTime(meeting.started_at, locale) })}
                          triggerIcon={<IconTrash size={18} />}
                          triggerIconOnly
                          triggerVariant="danger-ghost"
                          title={t("deleteMeetingTitle")}
                          description={t("deleteMeetingText")}
                          confirmLabel={t("deleteMeetingConfirm")}
                          pendingLabel={t("deleting")}
                        />
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-ink-3 border-t border-line px-6 pt-3 pb-4">
            {t("meetingsFoot")}
            {viewerEmail && t("meetingsFootEmail", { email: viewerEmail })}
          </p>
        </>
      )}
    </Panel>
  );
}

/** The account line under a person (0035): linked to a member, or invited by e-mail. */
function personStatus(
  p: OrgDetailViewProps["people"][number],
  members: OrgDetailViewProps["members"],
  t: (key: "hasAccount" | "hasAccountEmail" | "invited", values?: { email: string }) => string,
): string | null {
  const member = p.member_user_id ? members?.find((m) => m.userId === p.member_user_id) : undefined;
  if (member) return member.email ? t("hasAccountEmail", { email: member.email }) : t("hasAccount");
  if (p.email) return t("invited", { email: p.email });
  return null;
}

function PeoplePanel({
  orgId,
  people,
  members,
  isAdmin,
  actions,
}: {
  orgId: string;
  people: OrgDetailViewProps["people"];
  members?: OrgDetailViewProps["members"];
  isAdmin: boolean;
  actions: OrgDetailViewProps["actions"];
}) {
  // Members nobody has named yet (0035): shown here too, so the list holds everyone (audit U3).
  const t = useTranslations("org");
  const unnamed = (members ?? []).filter((m) => !people.some((p) => p.member_user_id === m.userId));
  return (
    <Panel flush title={t("peopleTitle")} titleId="people-title" actions={<span className="text-sm text-ink-3">{people.length + unnamed.length}</span>}>
      <p className="text-sm text-ink-3 -mt-2 px-6 pb-4">
        {t("peopleText")}
        {isAdmin && (
          <>
            {" "}
            {t.rich("peopleBoardLink", { link: (chunks) => <a href={`/orgs/${orgId}/kom-igang?steg=2`}>{chunks}</a> })}
          </>
        )}
      </p>
      <form action={actions.addPerson} className="flex items-end gap-2 px-6 pb-4">
        <input type="hidden" name="orgId" value={orgId} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label className="sr-only" htmlFor="new-person">
            {t("newPersonLabel")}
          </Label>
          <Input id="new-person" name="name" placeholder={t("newPersonPlaceholder")} required maxLength={100} autoComplete="off" />
        </div>
        <SubmitButton icon={<IconPlus />} pendingLabel={t("adding")}>
          {t("add")}
        </SubmitButton>
      </form>
      {people.length === 0 && unnamed.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title={t("noPeopleTitle")}>
            <p>{t("noPeopleText")}</p>
          </EmptyState>
        </div>
      ) : (
        <ul aria-labelledby="people-title">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              orgId={orgId}
              person={person}
              status={personStatus(person, members, t)}
              renamePerson={actions.renamePerson}
              setPersonRole={isAdmin ? actions.setPersonRole : undefined}
              deletePerson={actions.deletePerson}
            />
          ))}
          {unnamed.map((m) => (
            <li key={m.userId}>
              <div className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0">
                <span className="grid size-8 flex-none place-items-center rounded-full bg-sunk text-2xs font-semibold text-ink-3" aria-hidden="true">?</span>
                <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
                  <span className="font-medium wrap-anywhere">{m.email}</span>
                  <span className="text-sm text-ink-3">{t("unnamedMember")}</span>
                </span>
                {isAdmin && (
                  <a className={buttonVariants({ size: "sm" })} href={`/orgs/${orgId}/kom-igang?steg=2`}>
                    {t("linkToName")}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
