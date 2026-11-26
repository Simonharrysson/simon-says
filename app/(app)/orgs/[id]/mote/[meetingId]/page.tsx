import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { OrgMeetingView } from "@/components/home/OrgMeetingView";
import { isUuid } from "@/lib/db/ids";
import { loadOrgMeeting } from "@/lib/home/meeting";
import { stockholmDay } from "@/lib/home/tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("home"))("meeting.metaTitle"), robots: { index: false, follow: false } };
}

/** A förening meeting's summary in the app (from Mina uppgifter / Senaste mötena). Members only. */
export default async function OrgMeetingPage({ params }: { params: Promise<{ id: string; meetingId: string }> }) {
  const { id, meetingId } = await params;
  if (!isUuid(id) || !isUuid(meetingId)) notFound();
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/orgs/${id}/mote/${meetingId}`);
  const page = await loadOrgMeeting(db, user.id, id, meetingId);
  if (!page) notFound();
  // Still running: the live page.
  if (page.meeting.status === "live" || page.meeting.status === "ending") redirect(`/meetings/${meetingId}`);
  return <OrgMeetingView page={page} today={stockholmDay(new Date())} />;
}
