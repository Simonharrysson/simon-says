import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormatCard } from "@/components/views/FormatCard";
import { StartMeetingForm } from "@/components/views/StartMeetingForm";
import { OrgDetailView, type OrgTab } from "@/components/views/OrgDetailView";
import { OverviewView } from "@/components/views/OverviewView";
import { listGoals, loadOverview, type OrgGoal } from "@/lib/dashboard/load";
import type { Overview } from "@/lib/dashboard/overview";
import { isUuid } from "@/lib/db/ids";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { getOrg, listMeetings, listPeople, myRole } from "@/lib/db/orgs";
import { FORMAT_NAMES } from "@/lib/formats/standard";
import { listOrgFormats, orgDefaultFormat } from "@/lib/formats/store";
import { getEnv, pickerEnabled } from "@/lib/env";
import { appOrigin } from "@/lib/origin";
import { canRunTestMeeting } from "@/lib/testmeeting/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
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
} from "../actions";

export const dynamic = "force-dynamic";
// "Avsluta mötet" (endMeetingAction) runs the final notes pass after its response, in after().
export const maxDuration = 300;

const EMPTY_OVERVIEW: Overview = {
  meetingCount: 0,
  firstMeeting: null,
  lastMeeting: null,
  openTasks: [],
  decisions: [],
  topics: [],
  attendance: { meetings: 0, people: [] },
};
export const metadata: Metadata = { title: "Förening" };

/** The Översikt tab's data, read with the user's client (RLS: members of this org only). */
async function safeOverview(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string): Promise<{ overview: Overview; goals: OrgGoal[] } | null> {
  try {
    const [overview, goals] = await Promise.all([loadOverview(db, orgId), listGoals(db, orgId)]);
    return { overview, goals };
  } catch (err) {
    console.error("org page: overview unavailable", (err as Error)?.message);
    return null;
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

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fel?: string; klart?: string; flik?: string }>;
}) {
  const { id } = await params;
  const { fel, klart, flik } = await searchParams;
  const tab: OrgTab = flik === "oversikt" ? "oversikt" : "moten";
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  const [role, people, meetings, members, userResult, format, formats, dashboard] = await Promise.all([
    myRole(db, id),
    listPeople(db, id),
    listMeetings(db, id),
    safeMembers(id),
    db.auth.getUser(),
    orgDefaultFormat(db, id),
    listOrgFormats(db, id),
    tab === "oversikt" ? safeOverview(db, id) : Promise.resolve(null),
  ]);
  const inviteUrl = `${appOrigin()}/join/${org.invite_code}`;

  return (
    <OrgDetailView
      org={org}
      isAdmin={role === "admin"}
      userId={userResult.data.user?.id ?? null}
      inviteUrl={inviteUrl}
      members={members}
      people={people}
      meetings={meetings}
      notice={orgNotice(fel, klart)}
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
              loadError={!dashboard}
            />
          ) : undefined,
      }}
      formatCard={
        <FormatCard
          orgId={org.id}
          current={{ kind: format.profile.kind, name: FORMAT_NAMES[format.profile.kind], id: format.id, profile: format.profile }}
          isAdmin={role === "admin"}
          meetingFolder={{ id: org.meeting_folder_id ?? null }}
          formats={formats}
          changeFormat={changeFormatAction}
          pickerEnabled={pickerEnabled(getEnv())}
        />
      }
      liveMeetingHref={(meetingId) => `/meetings/${meetingId}`}
      startMeeting={<StartMeetingForm
          orgId={org.id}
          shareTranscript={org.share_transcript}
          showTestMeeting={canRunTestMeeting(userResult.data.user?.email)}
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
