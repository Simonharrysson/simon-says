import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { FormatCard } from "@/components/views/FormatCard";
import { StartMeetingForm } from "@/components/views/StartMeetingForm";
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
import { InviteByEmail } from "@/components/views/InviteByEmail";
import { inviterNameFor, listInvites } from "@/lib/invites/send";
import type { InviteRow } from "@/lib/invites/rules";
import { loadOnboarding } from "@/lib/onboarding/store";
import { showCard } from "@/lib/onboarding/steps";
import { logoUrl } from "@/lib/orgs/logo";
import { dismissAction, saveProfileAction } from "./kom-igang/actions";
import { OrgCalendarForm } from "@/components/calendar/OrgCalendarForm";
import type { StartCalendar } from "@/components/views/StartMeetingForm";
import { calendarResult, isNow, stockholmDateTime, type CalendarInfo } from "@/lib/calendar/events";
import { myCalendars, orgUpcoming, safeCalendarConnected, type UpcomingState } from "@/lib/calendar/load";
import type { Notice } from "@/lib/ui/messages";
import type { Locale } from "@/lib/i18n/config";
import { messages } from "@/lib/i18n/messages";
import { requestCalendarAccess, saveOrgCalendarAction } from "../../calendar-actions";
import { OrgProfileForm } from "@/components/views/OrgProfileForm";
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
  updateSummaryAction,
} from "../actions";

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

/** The start card's calendar part (todo #14), from the viewer's own grant. Undefined: no calendar chosen. */
function startCalendar(upcoming: UpcomingState): StartCalendar | undefined {
  const now = new Date();
  if (upcoming.state === "none") return undefined;
  if (upcoming.state === "disconnected") return { state: "disconnected", connect: requestCalendarAccess };
  if (upcoming.state === "unavailable") return { state: "unavailable" };
  return {
    state: "ok",
    events: upcoming.events.map((e) => ({ id: e.id, title: e.title, ...stockholmDateTime(e.start), now: isNow(e, now) })),
  };
}

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fel?: string; klart?: string; flik?: string; import?: string; drive?: string; kalender?: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations("org");
  const { fel, klart, flik, import: openImport, drive, kalender } = await searchParams;
  const tab: OrgTab = flik === "oversikt" ? "oversikt" : "moten";
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  // The Privat space (0045) is not a förening: it has its own page.
  if (org.kind === "privat") redirect("/privat");
  const [role, people, meetings, members, userResult, format, formats, dashboard, prepared, onboarding] = await Promise.all([
    myRole(db, id),
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
  const inviteUrl = `${appOrigin()}/join/${org.invite_code}`;
  const isAdmin = role === "admin";
  // The protocol import (admins, Översikt): has this admin's grant drive.readonly (the
  // incremental consent)? Read only here, for the import; never required anywhere else.
  const driveReadonly = isAdmin && tab === "oversikt" && userResult.data.user ? await safeDriveReadonly(userResult.data.user.id) : false;
  // Service role, so only after the role check above said admin.
  const importJob = isAdmin && tab === "oversikt" ? await safeImportJob(id) : null;
  const importBack = drive === "ok" || drive === "nej" || drive === "fel" || drive === "konto" ? drive : undefined;
  const me = userResult.data.user?.id ?? null;
  const invites = isAdmin ? await safeInvites(id) : [];
  // The calendar (todo #14), meetings tab only: the viewer's own grant reads the förening's calendar;
  // an admin also gets their own calendars to choose from. Best effort, never breaks the page.
  const calendarConnected = me && tab === "moten" ? await safeCalendarConnected(me) : false;
  const [upcoming, adminCalendars]: [UpcomingState, CalendarInfo[] | null] =
    me && tab === "moten"
      ? await Promise.all([
          !org.calendar_id ? { state: "none" as const } : calendarConnected ? orgUpcoming(me, org) : { state: "disconnected" as const },
          isAdmin && calendarConnected ? myCalendars(me) : null,
        ])
      : [{ state: "none" }, null];
  // Who may open each Doc: the starter and recorded shares (no Drive call per page view).
  const [shared, flags] = await Promise.all([sharedMeetingIds(db), appCreatedFlags(db, id)]);
  const docAccess = docAccessFor(
    meetings.map((m) => ({ ...m, app_created_doc: flags.get(m.id) ?? null })),
    me,
    shared,
  );

  return (
    <OrgDetailView
      org={org}
      isAdmin={role === "admin"}
      userId={userResult.data.user?.id ?? null}
      inviteUrl={inviteUrl}
      members={members}
      people={people}
      meetings={meetings}
      logoUrl={logoUrl(org.id, org.logo_updated_at)}
      komIgang={
        role === "admin" && showCard(onboarding) ? (
          <KomIgangCard orgId={org.id} state={onboarding} onDismiss={dismissAction.bind(null, org.id, true)} />
        ) : undefined
      }
      docAccess={docAccess}
      viewerEmail={userResult.data.user?.email ?? null}
      notice={orgNotice(fel, klart, locale) ?? calendarNotice(kalender, locale)}
      tabs={{
        active: tab,
        href: (t) => (t === "oversikt" ? `/orgs/${org.id}?flik=oversikt` : `/orgs/${org.id}`),
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
      profileSettings={isAdmin ? <OrgProfileForm orgId={org.id} profile={org} save={saveProfileAction} /> : undefined}
      calendarSettings={
        isAdmin ? (
          <OrgCalendarForm
            orgId={org.id}
            connected={calendarConnected}
            calendars={adminCalendars?.map((c) => ({ id: c.id, name: c.name })) ?? null}
            current={{ id: org.calendar_id ?? null, name: org.calendar_name ?? null, filter: org.calendar_filter ?? null }}
            save={saveOrgCalendarAction}
            connect={requestCalendarAccess}
          />
        ) : undefined
      }
      summarySettings={
        isAdmin ? (
          <SummarySettingsForm
            orgId={org.id}
            mode={org.summary_mode ?? "missed"}
            people={summaryOptions(people, members)}
            action={updateSummaryAction}
          />
        ) : undefined
      }
      inviteByEmail={
        isAdmin ? (
          <InviteByEmail
            orgId={org.id}
            orgName={org.name}
            inviterName={inviterNameFor(people.find((p) => p.member_user_id === me)?.name, userResult.data.user?.user_metadata)}
            inviteUrl={inviteUrl}
            invites={invites}
            memberEmails={(members ?? []).map((m) => m.email.toLowerCase()).filter(Boolean)}
          />
        ) : undefined
      }
      formatCard={
        <FormatCard
          orgId={org.id}
          current={{ kind: format.profile.kind, name: formatName(format.profile.kind, locale), id: format.id, profile: format.profile }}
          isAdmin={role === "admin"}
          meetingFolder={{ id: org.meeting_folder_id ?? null, name: org.meeting_folder_name ?? null }}
          formats={formats}
          changeFormat={changeFormatAction}
          pickerEnabled={pickerEnabled(getEnv())}
        />
      }
      liveMeetingHref={(meetingId) => `/meetings/${meetingId}`}
      startMeeting={<StartMeetingForm
          orgId={org.id}
          showTestMeeting={canRunTestMeeting(userResult.data.user?.email)}
          prepared={prepared.map((p) => ({ date: p.meeting_date, time: p.meeting_time, kind: p.kind, docUrl: docUrl(p.doc_id) }))}
          calendar={startCalendar(upcoming)}
        />}
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
