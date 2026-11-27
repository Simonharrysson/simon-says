import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { LiveMeetingController } from "@/components/live/LiveMeetingController";
import { isUuid } from "@/lib/db/ids";
import { getOrg, memberRole } from "@/lib/db/orgs";
import type { MeetingStatus } from "@/lib/db/types";
import { meetingTitle } from "@/lib/docs/create";
import { canRunMeeting } from "@/lib/meetings/access";
import { presence } from "@/lib/meetings/presence";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { privatTitle } from "@/lib/privat/format";
import { isPrivat, privatHref } from "@/lib/privat/space";
import { canResume, docUrl } from "@/lib/ui/meetings";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("common"))("metaMeeting"), robots: { index: false, follow: false } };
}

/**
 * The live meeting page (full-screen focus mode: outside the (app) layout). Any member of the
 * förening may run (continue) the meeting here; one tab at a time records it.
 */
export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stoppat?: string; svar?: string }>;
}) {
  const { id } = await params;
  const { stoppat, svar } = await searchParams;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/meetings/${isUuid(id) ? id : ""}`);
  if (!isUuid(id)) notFound();

  // As the user: RLS hides meetings of other orgs.
  const { data: m, error } = await db
    .from("meetings")
    .select("*")
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
  // Privat (0045): back to the context; the summary has its own page; there may be no Doc.
  const tp = await getTranslations("privat.live");
  const context = isPrivat(org) && m.context_id ? ((await db.from("contexts").select("id, name").eq("id", m.context_id).maybeSingle()).data as { id: string; name: string } | null) : null;
  const privat = isPrivat(org)
    ? { summaryHref: `/privat/mote/${m.id}`, backLabel: context ? tp("back", { name: context.name }) : tp("backHome") }
    : undefined;
  return (
    <main id="innehall">
      <LiveMeetingController
        orgId={org.id}
        orgName={context?.name ?? org.name}
        orgHref={privat ? privatHref(context?.id) : `/orgs/${org.id}`}
        shareTranscript={org.share_transcript}
        privat={privat}
        autoStopped={stoppat !== undefined}
        answersLost={svar === "ej-sparade"}
        stopReason={stoppat && stoppat !== "1" && /^[a-z_]{1,30}$/.test(stoppat) ? stoppat : null}
        shareFailed={shareFailed}
        missedMeetingFolder={missedMeetingFolder}
        meeting={{
          id: m.id,
          status,
          startedAt: m.started_at,
          docUrl: m.doc_id ? docUrl(m.doc_id) : "",
          title: context ? privatTitle(context.name, m.started_at) : meetingTitle(org.name, new Date(m.started_at)),
          currentElSessionId: m.current_el_session_id,
          resumable: canResume({ status, ended_at: m.ended_at }),
          captureSource: m.capture_source === "call" ? "call" : "room",
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
