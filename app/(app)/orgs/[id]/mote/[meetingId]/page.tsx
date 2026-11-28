import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { setGuestAccessAction } from "@/app/(app)/orgs/guest-actions";
import { OrgMeetingView } from "@/components/home/OrgMeetingView";
import { isUuid } from "@/lib/db/ids";
import { loadOrgMeeting } from "@/lib/home/meeting";
import { JUST_ENDED_MS } from "@/lib/meetings/next-meeting";
import { loadSummaryStatus } from "@/lib/meetings/recap";
import { stockholmDay } from "@/lib/home/tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("home"))("meeting.metaTitle"), robots: { index: false, follow: false } };
}

/**
 * A meeting's page in the app: where it ends (the live page comes here once the notes are final)
 * and its result from then on (Möten, Mina uppgifter, Senaste mötena). Members who may see it only.
 */
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
  const now = Date.now();
  const ended = page.meeting.endedAt ? now - Date.parse(page.meeting.endedAt) : null;
  const justEnded = page.meeting.status === "done" && ended !== null && ended >= 0 && ended <= JUST_ENDED_MS;
  const summary = page.meeting.status === "done" ? await loadSummaryStatus(db, meetingId) : null;
  return (
    <OrgMeetingView
      page={page}
      today={stockholmDay(new Date(now))}
      summary={page.guest ? null : summary}
      justEnded={justEnded}
      setGuestAccess={page.isAdmin ? setGuestAccessAction : undefined}
    />
  );
}
