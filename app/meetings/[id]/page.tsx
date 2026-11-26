import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LiveMeetingController } from "@/components/live/LiveMeetingController";
import { isUuid } from "@/lib/db/ids";
import { getOrg, memberRole } from "@/lib/db/orgs";
import type { MeetingStatus } from "@/lib/db/types";
import { meetingTitle } from "@/lib/docs/create";
import { canRunMeeting } from "@/lib/meetings/access";
import { presence } from "@/lib/meetings/presence";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canResume, docUrl } from "@/lib/ui/meetings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Möte", robots: { index: false, follow: false } };

/**
 * The live meeting page (full-screen focus mode: outside the (app) layout). Any member of the
 * förening may run (continue) the meeting here; one tab at a time records it.
 */
export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stoppat?: string }>;
}) {
  const { id } = await params;
  const { stoppat } = await searchParams;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/meetings/${isUuid(id) ? id : ""}`);
  if (!isUuid(id)) notFound();

  // As the user: RLS hides meetings of other orgs.
  const { data: m, error } = await db
    .from("meetings")
    .select("id, org_id, started_by, status, started_at, ended_at, doc_id, current_el_session_id, last_tick_ok_at, doc_paused_at, last_heartbeat_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`meeting page: ${error.message}`);
  if (!m) notFound();
  const org = await getOrg(db, m.org_id);
  if (!org) notFound();
  if (!canRunMeeting(await memberRole(db, org.id, user.id))) redirect(`/orgs/${org.id}`);

  const status = m.status as MeetingStatus;
  // How many members the Doc couldn't be shared with at start (logged on the started event).
  const { data: started } = await db
    .from("meeting_events")
    .select("detail")
    .eq("meeting_id", m.id)
    .in("kind", ["started", "test_started"])
    .order("at", { ascending: true })
    .limit(1);
  const shareFailedRaw = (started?.[0]?.detail as { shareFailed?: unknown } | undefined)?.shareFailed;
  const shareFailed = typeof shareFailedRaw === "number" ? shareFailedRaw : null;
  const missedMeetingFolder = (started?.[0]?.detail as { missedMeetingFolder?: unknown } | undefined)?.missedMeetingFolder === true;
  return (
    <main id="innehall">
      <LiveMeetingController
        orgId={org.id}
        orgName={org.name}
        orgHref={`/orgs/${org.id}`}
        shareTranscript={org.share_transcript}
        autoStopped={stoppat !== undefined}
        stopReason={stoppat && stoppat !== "1" && /^[a-z_]{1,30}$/.test(stoppat) ? stoppat : null}
        shareFailed={shareFailed}
        missedMeetingFolder={missedMeetingFolder}
        meeting={{
          id: m.id,
          status,
          startedAt: m.started_at,
          docUrl: docUrl(m.doc_id),
          title: meetingTitle(org.name, new Date(m.started_at)),
          currentElSessionId: m.current_el_session_id,
          resumable: canResume({ status, ended_at: m.ended_at }),
          lastTickOkAt: m.last_tick_ok_at,
          docPaused: m.doc_paused_at !== null,
          // Another tab (maybe another member's laptop) is recording it right now.
          connectedElsewhere: status === "live" && presence(m, Date.now()) === "connected",
          ...(m.ended_at ? { durationSeconds: (Date.parse(m.ended_at) - Date.parse(m.started_at)) / 1000 } : {}),
        }}
      />
    </main>
  );
}
