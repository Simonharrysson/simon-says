import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OrgDetailView } from "@/components/views/OrgDetailView";
import { isUuid } from "@/lib/db/ids";
import { memberEmails } from "@/lib/db/members";
import { getOrg, listMeetings, listPeople, myRole } from "@/lib/db/orgs";
import { originFrom } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
import {
  addPersonAction,
  deleteMeetingAction,
  deleteOrgAction,
  deletePersonAction,
  renamePersonAction,
  rotateInviteAction,
  updateOrgAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Förening" };

/** Member emails for the members panel. Service role, so only called after RLS let us read the org. */
async function safeMemberEmails(orgId: string): Promise<string[] | undefined> {
  try {
    return await memberEmails(orgId);
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
    safeMemberEmails(id),
    db.auth.getUser(),
  ]);
  const inviteUrl = `${originFrom(await headers())}/join/${org.invite_code}`;

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
      actions={{
        rotateInvite: rotateInviteAction,
        addPerson: addPersonAction,
        renamePerson: renamePersonAction,
        deletePerson: deletePersonAction,
        deleteMeeting: deleteMeetingAction,
        updateOrg: updateOrgAction,
        deleteOrg: deleteOrgAction,
      }}
    />
  );
}
