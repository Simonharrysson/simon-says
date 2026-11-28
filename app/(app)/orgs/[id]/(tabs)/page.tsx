import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { FormatCard } from "@/components/views/FormatCard";
import { NextMeetingHero, type NextMeetingHeroProps } from "@/components/views/NextMeetingHero";
import { MeetingMoreMenu } from "@/components/views/MeetingMoreMenu";
import { nextMeetingState, type HeroInput } from "@/lib/meetings/next-meeting";
import { loadSummaryStatus } from "@/lib/meetings/recap";
import { stockholmDay } from "@/lib/home/tasks";
import { SummarySettingsForm } from "@/components/views/SummarySettingsForm";
import { summaryOptions } from "@/lib/summaries/recipients";
import { OrgDetailView, type OrgTab } from "@/components/views/OrgDetailView";
import { OverviewView } from "@/components/views/OverviewView";
import { listGoals, loadOverview, type OrgGoal } from "@/lib/dashboard/load";
import { historySummary } from "@/lib/history/store";
import { currentJobId, jobView } from "@/lib/history/jobs";
import { isOpen, type JobView } from "@/lib/history/progress";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Overview } from "@/lib/dashboard/overview";
import { isUuid } from "@/lib/db/ids";
import { appCreatedFlags, sharedMeetingIds } from "@/lib/docs/access";
import { docAccessFor } from "@/lib/docs/access-state";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { getOrg, listMeetings, listPeople, myRole } from "@/lib/db/orgs";
import { formatName } from "@/lib/formats/standard";
import { listOrgFormats, orgDefaultFormat } from "@/lib/formats/store";
import { getEnv, pickerEnabled } from "@/lib/env";
import { hasImportAccess } from "@/lib/google/client";
import { appOrigin } from "@/lib/origin";
import { canRunTestMeeting } from "@/lib/testmeeting/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
import { docUrl } from "@/lib/ui/meetings";
import { localDate } from "@/lib/docs/create";
import { upcomingPrepared } from "@/lib/prepare/store";
import { KomIgangCard } from "@/components/onboarding/KomIgangCard";
import { WelcomeCard } from "@/components/views/WelcomeCard";
import { dueDayLabel } from "@/lib/home/tasks";
import { inviterNameFor, listInvites } from "@/lib/invites/send";
import type { InviteRow } from "@/lib/invites/rules";
import { loadOnboarding } from "@/lib/onboarding/store";
import { showCard } from "@/lib/onboarding/steps";
import { logoUrl } from "@/lib/orgs/logo";
import { dismissAction } from "../kom-igang/actions";
import { Suspense, type ReactNode } from "react";
import { OrgMemorySlot } from "@/components/settings/OrgMemorySlot";
import { HeroCalendarSlot, OrgCalendarSlot } from "@/components/calendar/CalendarSlots";
import { calendarResult } from "@/lib/calendar/events";
import type { Notice } from "@/lib/ui/messages";
import type { Locale } from "@/lib/i18n/config";
import { messages } from "@/lib/i18n/messages";
import { OrgDetailsForm } from "@/components/settings/OrgDetails";
import { ReopenKomIgang } from "@/components/settings/ReopenKomIgang";
import { MeetingFolderSetting, VoicesSetting } from "@/components/settings/MeetingSettings";
import { DriveAccountLostBanner } from "@/components/settings/DriveAccountLostBanner";
import { orgDriveAccount } from "@/lib/google/drive-account";
import { driveAccountView, driveResultOf, memberNames } from "@/lib/google/drive-account-rules";
import { blockedRevocationCount } from "@/lib/foretag/reconcile";
import { Skeleton } from "@/components/ui/skeleton";
import { OrgBoard } from "@/components/views/OrgBoard";
import { SettingsHashRedirect } from "@/components/views/SettingsHashRedirect";
import { loadMeetingList, type MeetingListInfo } from "@/lib/meetings/list";
import { orgTab, orgTabHref, sectionForCode } from "@/lib/orgs/tabs";
import { ForetagPage } from "./foretag-page";
import { boardRows } from "@/lib/people/board";
import { ForeningGroups } from "@/components/groups/ForeningGroups";
import type { PersonRow } from "@/lib/groups/people";
import { listTeams } from "@/lib/foretag/teams";
import type { GroupRow } from "@/lib/foretag/tree";
import { addTreePersonAction, setGroupsAction, setManagerAction } from "../../foretag-actions";
import {
  addPersonAction,
  changeFormatAction,
  deleteMeetingAction,
  deleteOrgAction,
  endMeetingAction,
  deletePersonAction,
  leaveOrgAction,
  removeMemberAction,
  renamePersonAction,
  setMemberRoleAction,
  setPersonRoleAction,
  rotateInviteAction,
  updateOrgAction,
} from "../../actions";

export const dynamic = "force-dynamic";
// "Avsluta mötet" (endMeetingAction) runs the final notes pass after its response, in after().
export const maxDuration = 300;

const EMPTY_OVERVIEW: Overview = {
  meetingCount: 0,
  firstMeeting: null,
  imported: { count: 0, first: null, last: null },
};
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("org"))("metaTitle") };
}

/** The Översikt tab's data, read with the user's client (RLS: members of this org only). */
async function safeOverview(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  orgId: string,
): Promise<{ overview: Overview; goals: OrgGoal[]; historyCount: number } | null> {
  try {
    const [overview, goals, historyCount] = await Promise.all([
      loadOverview(db, orgId),
      listGoals(db, orgId),
      // Imported protocols (0032); a read failure only hides the line, never the overview.
      historySummary(db, orgId).then(
        (h) => h.count,
        (err) => {
          console.error("org page: history summary unavailable", (err as Error)?.message);
          return 0;
        },
      ),
    ]);
    return { overview, goals, historyCount };
  } catch (err) {
    console.error("org page: overview unavailable", (err as Error)?.message);
    return null;
  }
}

/** The import the admin's Översikt shows (0036): open, or finished and not yet closed. Never breaks the page. */
async function safeImportJob(orgId: string): Promise<JobView | null> {
  try {
    const admin = supabaseAdmin();
    const jobId = await currentJobId(admin, orgId);
    return jobId ? await jobView(admin, jobId) : null;
  } catch (err) {
    console.error("org page: import job unavailable", (err as Error)?.message);
    return null;
  }
}

/** Has the user live read access for the protocol import (0034)? A read failure counts as no. */
async function safeDriveReadonly(userId: string): Promise<boolean> {
  try {
    return await hasImportAccess(userId);
  } catch (err) {
    console.error("org page: google scope unavailable", (err as Error)?.message);
    return false;
  }
}

/** The admin's sent invites (0038). Service role, so only after the admin check; never breaks the page. */
async function safeInvites(orgId: string): Promise<InviteRow[]> {
  try {
    return await listInvites(supabaseAdmin(), orgId);
  } catch (err) {
    console.error("org page: invites unavailable", (err as Error)?.message);
    return [];
  }
}

/** Members for the members panel. Service role, so only called after RLS let us read the org. */
async function safeMembers(orgId: string): Promise<OrgMember[] | undefined> {
  try {
    return await orgMemberList(orgId);
  } catch (err) {
    console.error("org page: member emails unavailable", (err as Error)?.message);
    return undefined;
  }
}

/** The `?kalender=` result of "Koppla kalender" (from the start card or Inställningar) as the page notice. */
function calendarNotice(raw: string | undefined, locale: Locale): Notice | null {
  const result = calendarResult(raw);
  if (!result) return null;
  return { tone: result === "ok" || result === "fran" ? "success" : "danger", text: messages[locale].calendar.result[result], code: `kalender-${result}` };
}

/** Grupper's data (0054): the groups and each person's place. A failed read leaves the section out. */
async function loadGroupSettings(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string): Promise<{ groups: GroupRow[]; people: PersonRow[] } | null> {
  try {
    const [groups, people] = await Promise.all([listTeams(db, orgId), db.from("people").select("*").eq("org_id", orgId).order("name")]);
    if (people.error) throw new Error(people.error.message);
    return { groups, people: (people.data ?? []) as PersonRow[] };
  } catch (err) {
    console.error(`org page: groups: ${(err as Error).message}`);
    return null;
  }
}

/** Group names by id (0054), read as the user; a failed read only leaves the names out. */
async function safeGroupNames(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string): Promise<Map<string, string> | null> {
  try {
    return new Map((await listTeams(db, orgId)).map((g) => [g.id, g.name]));
  } catch (err) {
    console.error(`org page: group names: ${(err as Error).message}`);
    return null;
  }
}

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fel?: string; klart?: string; flik?: string; import?: string; drive?: string; kalender?: string; valkommen?: string; drivekonto?: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations("org");
  const { fel, klart, flik, import: openImport, drive, kalender, valkommen, drivekonto } = await searchParams;
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  // The Privat space (0045) is not a förening: it has its own page.
  if (org.kind === "privat") redirect("/privat");
  const role = await myRole(db, id);
  // A Företag (0050) has its own page; nothing of the förening page below runs for it.
  if (org.kind === "foretag") {
    const { data: me } = await db.auth.getUser();
    if (!role || !me.user) notFound();
    return <ForetagPage org={org} role={role} userId={me.user.id} flik={flik} fel={fel} klart={klart} />;
  }
  const notice = orgNotice(fel, klart, locale) ?? calendarNotice(kalender, locale);
  const tab: OrgTab = orgTab({ flik, isAdmin: role === "admin", noticeCode: notice?.code });
  const [people, meetings, members, userResult, format, formats, dashboard, prepared, onboarding] = await Promise.all([
    listPeople(db, id),
    listMeetings(db, id),
    safeMembers(id),
    db.auth.getUser(),
    orgDefaultFormat(db, id),
    listOrgFormats(db, id),
    tab === "oversikt" ? safeOverview(db, id) : Promise.resolve(null),
    upcomingPrepared(db, id, localDate(new Date())),
    loadOnboarding(db, id),
  ]);
  // The meeting list's titles, Testmöten and counts (0048): only where the list shows.
  const meetingInfo: Record<string, MeetingListInfo> = tab === "moten" ? await loadMeetingList(db, id, t("titleAnd")) : {};
  const inviteUrl = `${appOrigin()}/join/${org.invite_code}`;
  const isAdmin = role === "admin";
  // The protocol import (admins, Översikt): has this admin's grant drive.readonly (the
  // incremental consent)? Read only here, for the import; never required anywhere else.
  const driveReadonly = isAdmin && tab === "oversikt" && userResult.data.user ? await safeDriveReadonly(userResult.data.user.id) : false;
  // Service role, so only after the role check above said admin.
  const importJob = isAdmin && tab === "oversikt" ? await safeImportJob(id) : null;
  const importBack = drive === "ok" || drive === "nej" || drive === "fel" || drive === "konto" ? drive : undefined;
  const me = userResult.data.user?.id ?? null;
  // After "Gå med" + "Vem av dessa är du?" (0051): who they are here and the next prepared meeting.
  const nextPrepared = prepared[0];
  const welcome =
    valkommen === "1" ? (
      <WelcomeCard
        orgId={org.id}
        orgName={org.name}
        name={people.find((p) => p.member_user_id === me)?.name ?? null}
        nextMeeting={nextPrepared ? `${dueDayLabel(nextPrepared.meeting_date, locale === "en" ? "en" : "sv")}${nextPrepared.meeting_time ? ` ${nextPrepared.meeting_time.slice(0, 5)}` : ""}` : null}
      />
    ) : null;
  const invites = isAdmin && tab === "installningar" ? await safeInvites(id) : [];
  const settings = isAdmin && tab === "installningar";
  // 0070: the förening's own Drive account, for admins only (service role, never its token).
  const driveAccount = isAdmin ? await orgDriveAccount(id).catch(() => null) : null;
  const driveView = driveAccountView(driveAccount, me ?? "", org.meeting_folder_id ?? null, memberNames(people, members ?? []));
  const stuckShares = settings ? await blockedRevocationCount(id) : 0;
  const board = boardRows(people, members ?? []);
  // Grupper (0054): the tree and everyone's place, read as the admin (RLS).
  const tree = settings ? await loadGroupSettings(db, id) : null;
  // Who may open each Doc: the starter and recorded shares (no Drive call per page view).
  const [shared, flags] = await Promise.all([sharedMeetingIds(db), appCreatedFlags(db, id)]);
  // A förening with groups (0054): each meeting's group by name ("Hela föreningen" without one).
  const groupNames = org.groups_enabled && tab === "moten" ? await safeGroupNames(db, id) : null;
  const tp = await getTranslations("foretag.picker.forening");
  const listed = groupNames
    ? meetings.map((m) => ({ ...m, forGroup: m.group_id ? (groupNames.get(m.group_id) ?? null) : tp("whole") }))
    : meetings.map((m) => ({ ...m, private: false }));
  const docAccess = docAccessFor(
    meetings.map((m) => ({ ...m, app_created_doc: flags.get(m.id) ?? null })),
    me,
    shared,
  );

  // The Möten tab's Nästa möte card (the weekly loop), from the lists read above as the viewer.
  let hero: ReactNode = null;
  if (tab === "moten") {
    const now = new Date();
    const input: HeroInput = {
      meetings: meetings.map((m) => ({ ...m, isTest: meetingInfo[m.id]?.isTest ?? false })),
      prepared: prepared.map((p) => ({ date: p.meeting_date, time: p.meeting_time, kind: p.kind, docUrl: docUrl(p.doc_id) })),
      now,
      today: stockholmDay(now),
      canPrepare: true,
    };
    const state = nextMeetingState(input);
    const about = state.kind === "ended" ? meetings.find((m) => m.id === state.meetingId) : undefined;
    const heroProps: Omit<NextMeetingHeroProps, "state" | "calendar"> = {
      orgId: org.id,
      meeting: about
        ? {
            id: about.id,
            title: meetingInfo[about.id]?.title ?? null,
            startedAt: about.started_at,
            endedAt: about.ended_at,
            decisions: meetingInfo[about.id]?.decisions ?? 0,
            tasks: meetingInfo[about.id]?.tasks ?? 0,
          }
        : null,
      summary: about ? await loadSummaryStatus(db, about.id) : null,
      more: canRunTestMeeting(userResult.data.user?.email) && (state.kind !== "live" && state.kind !== "ending") ? <MeetingMoreMenu orgId={org.id} /> : null,
    };
    // Only "not prepared" and "prepared" can change with the calendar; the card holds its size meanwhile.
    hero =
      me && org.calendar_id && (state.kind === "prepared" || state.kind === "unprepared") ? (
        <Suspense fallback={<NextMeetingHero {...heroProps} state={state} pending />}>
          <HeroCalendarSlot org={org} userId={me} input={input} hero={heroProps} />
        </Suspense>
      ) : (
        <NextMeetingHero {...heroProps} state={state} />
      );
  }

  return (
    <OrgDetailView
      org={org}
      isAdmin={role === "admin"}
      userId={userResult.data.user?.id ?? null}
      inviteUrl={inviteUrl}
      members={members}
      people={people}
      meetings={listed}
      meetingInfo={meetingInfo}
      logoUrl={logoUrl(org.id, org.logo_updated_at)}
      komIgang={
        <>
          {welcome}
          {role === "admin" && showCard(onboarding) && tab !== "installningar" && (
            <KomIgangCard orgId={org.id} state={onboarding} onDismiss={dismissAction.bind(null, org.id, true)} />
          )}
          {isAdmin && tab === "moten" && <SettingsHashRedirect href={orgTabHref(org.id, "installningar")} />}
          {driveView?.lost && !settings && <DriveAccountLostBanner email={driveView.email} href={`${orgTabHref(org.id, "installningar")}&del=moten`} />}
        </>
      }
      docAccess={docAccess}
      viewerEmail={userResult.data.user?.email ?? null}
      notice={notice}
      tabs={{
        active: tab,
        href: (t) => orgTabHref(org.id, t),
        overview:
          tab === "oversikt" ? (
            <OverviewView
              orgId={org.id}
              isAdmin={role === "admin"}
              overview={dashboard?.overview ?? EMPTY_OVERVIEW}
              goals={(dashboard?.goals ?? []).map((g) => ({ title: g.title, why: g.why }))}
              historyCount={dashboard?.historyCount ?? 0}
              loadError={!dashboard}
              importAccess={{
                driveReadonly,
                email: userResult.data.user?.email ?? null,
                meetingFolder: org.meeting_folder_id ? { id: org.meeting_folder_id, name: org.meeting_folder_name ?? t("meetingFolderFallback") } : null,
              }}
              importJob={importJob}
              initialGoalsPhase={isAdmin && openImport === "1" && !(importJob && isOpen(importJob.status)) ? { phase: "import", consent: importBack } : undefined}
            />
          ) : undefined,
      }}
      settingsSection={settings ? (sectionForCode(notice?.code) ?? undefined) : undefined}
      boardList={
        settings
          ? (memberControls, linkActions) => (
              <OrgBoard
                orgId={org.id}
                orgName={org.name}
                rows={board}
                inviteUrl={inviteUrl}
                myEmail={userResult.data.user?.email?.toLowerCase() ?? null}
                invites={invites}
                inviterName={inviterNameFor(people.find((p) => p.member_user_id === me)?.name, userResult.data.user?.user_metadata)}
                memberControls={memberControls}
                linkActions={linkActions}
              />
            )
          : undefined
      }
      groupSettings={
        tree && me ? (
          <ForeningGroups
            org={org}
            userId={me}
            groups={tree.groups}
            people={tree.people}
            members={members ?? []}
            actions={{ setManager: setManagerAction, addPerson: addTreePersonAction, setGroups: setGroupsAction }}
          />
        ) : undefined
      }
      detailsSettings={
        settings ? (
          <OrgDetailsForm
            org={{
              id: org.id,
              name: org.name,
              logoUpdatedAt: org.logo_updated_at ?? null,
              profile: { about: org.about ?? null, website_url: org.website_url ?? null, facebook_url: org.facebook_url ?? null, instagram_url: org.instagram_url ?? null },
            }}
          />
        ) : undefined
      }
      reopenKomIgang={
        settings && onboarding && (onboarding.dismissedAt || onboarding.completedAt) ? (
          <ReopenKomIgang orgId={org.id} reopen={onboarding.dismissedAt ? dismissAction.bind(null, org.id, false) : undefined} />
        ) : undefined
      }
      folderSettings={
        settings ? (
          <MeetingFolderSetting
            orgId={org.id}
            folderName={org.meeting_folder_name ?? null}
            folderSet={Boolean(org.meeting_folder_id)}
            pickerEnabled={pickerEnabled(getEnv())}
            driveAccount={driveView}
            driveResult={driveResultOf(drivekonto)}
            stuckShares={stuckShares}
          />
        ) : undefined
      }
      voiceSettings={settings ? <VoicesSetting orgId={org.id} board={board} /> : undefined}
      calendarSettings={
        settings && me ? (
          // Google's answer streams in; the rest of the page never waits for it (todo #14). The
          // placeholder holds the form's place, so nothing below it moves.
          <Suspense fallback={<Skeleton className="h-36 rounded-md" />}>
            <OrgCalendarSlot orgId={org.id} userId={me} org={org} />
          </Suspense>
        ) : undefined
      }
      memorySettings={
        settings ? (
          <Suspense fallback={<Skeleton className="h-64 rounded-md" />}>
            <OrgMemorySlot orgId={org.id} />
          </Suspense>
        ) : undefined
      }
      summarySettings={
        settings ? (
          <SummarySettingsForm
            orgId={org.id}
            mode={org.summary_mode ?? "missed"}
            people={summaryOptions(people, members)}
          />
        ) : undefined
      }
      formatCard={
        <FormatCard
          orgId={org.id}
          current={{ kind: format.profile.kind, name: formatName(format.profile.kind, locale), id: format.id, profile: format.profile }}
          isAdmin={role === "admin"}
          formats={formats}
          changeFormat={changeFormatAction}
          pickerEnabled={pickerEnabled(getEnv())}
        />
      }
      liveMeetingHref={(meetingId) => `/meetings/${meetingId}`}
      startMeeting={hero}
      actions={{
        rotateInvite: rotateInviteAction,
        addPerson: addPersonAction,
        renamePerson: renamePersonAction,
        setPersonRole: setPersonRoleAction,
        deletePerson: deletePersonAction,
        deleteMeeting: deleteMeetingAction,
        endMeeting: endMeetingAction,
        updateOrg: updateOrgAction,
        deleteOrg: deleteOrgAction,
        removeMember: removeMemberAction,
        leaveOrg: leaveOrgAction,
        setMemberRole: setMemberRoleAction,
      }}
    />
  );
}
