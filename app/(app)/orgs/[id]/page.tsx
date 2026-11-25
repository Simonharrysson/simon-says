import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StartMeetingForm } from "@/components/views/StartMeetingForm";
import { OrgDetailView } from "@/components/views/OrgDetailView";
import { isUuid } from "@/lib/db/ids";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { getOrg, listMeetings, listPeople, myRole } from "@/lib/db/orgs";
import { appOrigin } from "@/lib/origin";
import { canRunTestMeeting } from "@/lib/testmeeting/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
import {
  addPersonAction,
  deleteMeetingAction,
  deleteOrgAction,
  deletePersonAction,
  leaveOrgAction,
  removeMemberAction,
  renamePersonAction,
  rotateInviteAction,
  updateOrgAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Förening" };

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
  searchParams: Promise<{ fel?: string; klart?: string }>;
}) {
  const { id } = await params;
  const { fel, klart } = await searchParams;
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  const [role, people, meetings, members, userResult] = await Promise.all([
    myRole(db, id),
    listPeople(db, id),
    listMeetings(db, id),
    safeMembers(id),
    db.auth.getUser(),
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
        deletePerson: deletePersonAction,
        deleteMeeting: deleteMeetingAction,
        updateOrg: updateOrgAction,
        deleteOrg: deleteOrgAction,
        removeMember: removeMemberAction,
        leaveOrg: leaveOrgAction,
      }}
    />
  );
}
