import { AppLink } from "@/components/ui/AppLink";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight, IconChevronDown, IconExternal, IconMic, IconPlay, IconPlus, IconRefresh, IconStop, IconTrash } from "@/components/ui/icons";
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
import { OrgSettings } from "@/components/settings/OrgSettings";
import { settingsHref, type SettingsSectionId } from "@/lib/orgs/tabs";
import { OrgTabsShell } from "./OrgTabsShell";
import { PersonRow } from "./PersonRow";
import { OrgLogo } from "@/components/onboarding/OrgLogo";
import type { OrgProfile } from "@/lib/orgs/profile";
import { OrgAbout } from "./OrgAbout";
import type { MeetingListInfo } from "@/lib/meetings/list";

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
  org: { id: string; name: string; share_transcript: boolean; show_on_status: boolean; require_task_fields?: boolean } & Partial<OrgProfile>;
  isAdmin: boolean;
  userId: string | null;
  inviteUrl: string;
  /** Members (email, role), oldest first. Omitted when unavailable. */
  members?: { userId: string; email: string; role: "admin" | "member" }[];
  people: { id: string; name: string; role?: string | null; email?: string | null; member_user_id?: string | null }[];
  meetings: OrgDetailMeeting[];
  /** Per meeting id: title, Testmöte, decision and task counts (`loadMeetingList`). Missing: the date only. */
  meetingInfo?: Record<string, MeetingListInfo>;
  /**
   * Admins, Inställningar: the one board list (`OrgBoard`, also Kom igång's step 2), given each
   * member's account controls by user id and the invite link's "Skapa ny länk".
   */
  boardList?: (memberControls: Record<string, ReactNode>, linkActions: ReactNode) => ReactNode;
  /** Admins: the Inställningar section to open (`settingsSection`, lib/orgs/tabs.ts). */
  settingsSection?: SettingsSectionId;
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
  /** Admins: "Sammanfattning efter mötet" (`SummarySettingsForm`, 0037), Inställningar → Efter mötet. */
  summarySettings?: ReactNode;
  /** Admins: name, logo and "Om oss" (`OrgDetailsForm`), Inställningar → Föreningen. */
  detailsSettings?: ReactNode;
  /** Admins: the meeting folder (`MeetingFolderSetting`), Inställningar → Möten. */
  folderSettings?: ReactNode;
  /** Admins: voices (`VoicesSetting`), Inställningar → Möten. */
  voiceSettings?: ReactNode;
  /** Admins: "Mötenas kalender" (`OrgCalendarForm`, 0046), Inställningar → Möten. */
  calendarSettings?: ReactNode;
  /**
   * Link into a meeting's live page (Task 7), e.g. id => `/meetings/${id}`. Any member may
   * continue a running meeting (and one abandoned < 2 h ago) there. Hidden when absent.
   */
  liveMeetingHref?: (meetingId: string) => string;
  /**
   * The tabs: when given, a tab bar shows under the header. "moten": start and the meeting list;
   * "oversikt": `overview`; "installningar" (admins only): the board, invites, format, settings and
   * deleting the förening. `href` builds the links. Without tabs everything shows on one page.
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
 * A member's account controls, shown on their row of the board list (Inställningar). Admins can
 * make others admin or take it away, and remove members; everyone can leave. The last admin is
 * offered neither stepping down nor leaving (the DB refuses both too, migration 0031): the row
 * says what to do instead.
 */
function MemberControls({
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

  return controls;
}

export type OrgTab = "moten" | "oversikt" | "installningar";
const TABS: { id: OrgTab; label: "tabMeetings" | "tabOverview" | "tabSettings"; adminOnly?: boolean }[] = [
  { id: "moten", label: "tabMeetings" },
  { id: "oversikt", label: "tabOverview" },
  { id: "installningar", label: "tabSettings", adminOnly: true },
];

/** Everyone in the list plus members nobody has named yet, the same count as Personer shows. */
function peopleTotal(people: OrgDetailViewProps["people"], members: OrgDetailViewProps["members"]): number {
  return people.length + (members ?? []).filter((m) => !people.some((p) => p.member_user_id === m.userId)).length;
}

const statusTone: Record<MeetingStatus, BadgeTone> = {
  live: "live",
  ending: "neutral",
  done: "success",
  abandoned: "neutral",
};

export function OrgDetailView(props: OrgDetailViewProps) {
  const { org, isAdmin, userId, inviteUrl, members, people, meetings, notice, startMeetingHref, liveMeetingHref, tabs, actions, logoUrl, komIgang, inviteByEmail } = props;
  const t = useTranslations("org");
  const tc = useTranslations("common");
  const active = meetings.find((m) => m.status === "live" || m.status === "ending");
  // Any member may continue the running meeting from their own device (Meet-like presence).
  const running = liveMeetingHref && active?.status === "live" && userId !== null ? active : null;
  // Without tabs (older callers) everything an admin has shows on the one page, as before.
  const tab: OrgTab = tabs?.active ?? "moten";

  const invitePanel = (
    <Panel title={t("inviteTitle")} titleId="invite-title" id="bjud-in" className="scroll-mt-6">
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
  );

  // Each member's account controls, for their row of the board list (Inställningar).
  const memberControls: Record<string, ReactNode> = {};
  for (const m of members ?? []) {
    memberControls[m.userId] = (
      <MemberControls
        member={m}
        me={userId !== null && m.userId === userId}
        org={org}
        isAdmin={isAdmin}
        adminCount={(members ?? []).filter((x) => x.role === "admin").length}
        memberCount={(members ?? []).length}
        actions={actions}
      />
    );
  }

  const panel = <OrgPanels {...props} tab={tab} invitePanel={invitePanel} memberControls={memberControls} />;
  const peopleCount = peopleTotal(people, members);

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
              <span className="text-sm text-ink-3">{t("counts", { people: peopleCount, meetings: meetings.length })}</span>
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
      {tabs ? (
        <OrgTabsShell
          key={org.id}
          active={tab}
          label={t("tabsLabel")}
          loadingLabel={tc("loading")}
          tabs={TABS.filter((x) => isAdmin || !x.adminOnly).map((x) => ({ id: x.id, label: t(x.label), href: tabs.href(x.id) }))}
          between={
            <>
              <NoticeBanner notice={notice} />
              {komIgang}
            </>
          }
        >
          {tab === "oversikt" ? tabs.overview : panel}
        </OrgTabsShell>
      ) : (
        <>
          <NoticeBanner notice={notice} />
          {komIgang}
          {panel}
        </>
      )}
    </div>
  );
}

/** Möten and Inställningar of OrgDetailView (split out so the tab shell can hold them). */
function OrgPanels(props: OrgDetailViewProps & { tab: OrgTab; invitePanel: ReactNode; memberControls: Record<string, ReactNode> }) {
  const { org, isAdmin, userId, members, people, meetings, meetingInfo, viewerEmail, startMeeting, liveMeetingHref, tabs, actions, tab, invitePanel, memberControls } = props;
  const t = useTranslations("org");
  const access = (m: OrgDetailMeeting): DocAccess => props.docAccess?.[m.id] ?? "open";
  const starter = (m: OrgDetailMeeting) => members?.find((x) => x.userId === m.started_by)?.email || t("starterFallback");
  const active = meetings.find((m) => m.status === "live" || m.status === "ending");
  const settingsHere = isAdmin && (!tabs || tab === "installningar");
  const meetingsHere = !tabs || tab === "moten";
  return (
    <>
      {meetingsHere && (
        <div className={isAdmin ? "flex flex-col gap-6" : "grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]"}>
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
              info={meetingInfo}
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
          </div>

          {/* Members: who is in the förening and the invite link; admins have all of it under Inställningar. */}
          {!isAdmin && (
            <div className="flex flex-col gap-6">
              <PeoplePanel orgId={org.id} people={people} members={members} isAdmin={false} actions={actions} />
              {invitePanel}
              {actions.leaveOrg && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                  <p className="text-sm text-ink-3">{t("leaveHint")}</p>
                  <ConfirmAction
                    action={actions.leaveOrg}
                    hidden={{ orgId: org.id }}
                    trigger={t("leaveConfirm")}
                    triggerVariant="ghost"
                    title={t("leaveTitle", { org: org.name })}
                    description={t("leaveText")}
                    confirmLabel={t("leaveConfirm")}
                    pendingLabel={t("leaving")}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {settingsHere && (
        <OrgSettings
          {...props}
          memberControls={memberControls}
          rotateInvite={
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
          }
        />
      )}
    </>
  );
}

/** The meeting list shows this many, newest first; the rest open under "Visa fler". */
export const MEETINGS_SHOWN = 5;

/**
 * Split for the list: running and resumable meetings always show (a Testmöte too: it has
 * controls); other Testmöten fold away under "Visa testmöten"; the rest newest first, 5 shown.
 */
export function splitMeetings<M extends OrgDetailMeeting>(meetings: M[], info: Record<string, MeetingListInfo> | undefined): { shown: M[]; more: M[]; tests: M[] } {
  const pinned = (m: M) => m.status === "live" || m.status === "ending" || (m.status === "abandoned" && canResume(m));
  const sorted = [...meetings].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const tests = sorted.filter((m) => info?.[m.id]?.isTest && !pinned(m));
  const main = sorted.filter((m) => !tests.includes(m));
  return { shown: main.slice(0, MEETINGS_SHOWN), more: main.slice(MEETINGS_SHOWN), tests };
}

type MeetingsPanelProps = {
  viewerEmail?: string | null;
  access: (m: OrgDetailMeeting) => DocAccess;
  starter: (m: OrgDetailMeeting) => string;
  meetings: OrgDetailMeeting[];
  info?: Record<string, MeetingListInfo>;
  orgId: string;
  isAdmin: boolean;
  userId: string | null;
  deleteMeeting: FormAction;
  endMeeting?: FormAction;
  liveMeetingHref?: (meetingId: string) => string;
};

function MeetingsPanel(props: MeetingsPanelProps) {
  const { meetings, info, viewerEmail } = props;
  const t = useTranslations("org");
  const { shown, more, tests } = splitMeetings(meetings, info);
  const rows = (list: OrgDetailMeeting[]) => list.map((m) => <MeetingRow key={m.id} meeting={m} {...props} />);
  const fold = "group border-t border-line [&[open]>summary_svg]:rotate-180";
  const summary =
    "flex min-h-11 cursor-pointer list-none items-center gap-2 px-6 py-2 text-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden";
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
          {shown.length > 0 && <ul aria-labelledby="meetings-title">{rows(shown)}</ul>}
          {more.length > 0 && (
            <details className={fold}>
              <summary className={summary}>
                <IconChevronDown size={16} className="transition-transform duration-120" />
                {t("showMore", { count: more.length })}
              </summary>
              <ul aria-label={t("olderMeetings")} className="border-t border-line">
                {rows(more)}
              </ul>
            </details>
          )}
          {tests.length > 0 && (
            <details className={fold}>
              <summary className={summary}>
                <IconChevronDown size={16} className="transition-transform duration-120" />
                {t("showTests", { count: tests.length })}
              </summary>
              <ul aria-label={t("testMeetings")} className="border-t border-line">
                {rows(tests)}
              </ul>
            </details>
          )}
          {viewerEmail && <p className="text-sm text-ink-3 border-t border-line px-6 pt-3 pb-4">{t("meetingsFootEmail", { email: viewerEmail })}</p>}
        </>
      )}
    </Panel>
  );
}

function MeetingRow({
  meeting,
  info,
  orgId,
  isAdmin,
  userId,
  deleteMeeting,
  endMeeting,
  liveMeetingHref,
  access,
  starter,
  viewerEmail,
}: MeetingsPanelProps & { meeting: OrgDetailMeeting }) {
  const t = useTranslations("org");
  const common = useTranslations("common");
  const locale = useLocale();
  const state = meetingDeleteState(meeting, { isAdmin, userId });
  const mine = userId !== null && meeting.started_by === userId;
  const about = info?.[meeting.id];
  const date = formatMeetingDate(meeting.started_at, undefined, locale);
  const duration =
    meeting.ended_at && formatDuration((new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 1000, locale);
  const counts =
    about && (about.decisions > 0 || about.tasks > 0) ? t("itemCounts", { decisions: about.decisions, tasks: about.tasks }) : null;
  return (
    <li id={`mote-${meeting.id}`} className="scroll-mt-6">
      <div className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0 max-[30rem]:flex-wrap">
        <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
          {meeting.status === "done" ? (
            <AppLink
              href={`/orgs/${orgId}/mote/${meeting.id}`}
              className="self-start rounded-sm font-medium text-ink no-underline wrap-anywhere decoration-ink-3 underline-offset-[0.2em] hover:underline active:text-ink-2"
            >
              {about?.title ?? date}
            </AppLink>
          ) : (
            <span className="font-medium wrap-anywhere">{about?.title ?? date}</span>
          )}
          <span className="mt-[0.15rem] flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            {about?.isTest && <Badge tone="neutral">{t("testMeeting")}</Badge>}
            {meeting.status !== "done" && <Badge tone={statusTone[meeting.status]}>{t(`status.${meeting.status}`)}</Badge>}
            <span>{[about?.title ? date : null, duration, counts].filter(Boolean).join(" · ")}</span>
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
            <a className={buttonVariants({ size: "sm" })} href={docUrl(meeting.doc_id)} target="_blank" rel="noopener noreferrer">
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
            {t.rich("peopleBoardLink", { link: (chunks) => <AppLink href={settingsHref(orgId, "styrelsen")}>{chunks}</AppLink> })}
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
                  <a className={buttonVariants({ size: "sm" })} href={settingsHref(orgId, "styrelsen")}>
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
