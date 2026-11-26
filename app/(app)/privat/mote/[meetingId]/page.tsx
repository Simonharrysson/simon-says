import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PrivatMeetingView, type SummaryStatus } from "@/components/privat/PrivatMeetingView";
import { isUuid } from "@/lib/db/ids";
import { loadMeetingPage } from "@/lib/privat/load";
import { privatNotice } from "@/lib/privat/messages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { docUrl } from "@/lib/ui/meetings";
import { deletePrivatMeetingAction, setTaskDoneAction } from "../../actions";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("privat"))("meetingMetaTitle"), robots: { index: false, follow: false } };
}

export default async function PrivatMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ meetingId: string }>;
  searchParams: Promise<{ fel?: string; klart?: string }>;
}) {
  const { meetingId } = await params;
  const { fel, klart } = await searchParams;
  if (!isUuid(meetingId)) notFound();
  const db = await createSupabaseServerClient();
  const data = await loadMeetingPage(db, meetingId);
  if (!data || !data.context) notFound();
  const m = data.meeting;
  const tp = await getTranslations("privat");
  // Still recording: the live page.
  if (m.status === "live" || m.status === "ending") redirect(`/meetings/${m.id}`);
  const status: SummaryStatus = data.summary
    ? "ready"
    : m.summary_state === "no_notes" || m.status === "abandoned"
      ? "none"
      : m.summary_state === "failed" || m.summary_state === "none"
        ? "failed"
        : "pending";
  return (
    <PrivatMeetingView
      meetingId={m.id}
      context={data.context}
      startedAt={m.started_at}
      status={status}
      summary={
        data.summary && {
          summary: data.summary.summary,
          decisions: data.summary.decisions,
          facts: data.summary.facts,
          questions: data.summary.questions,
          sinceLast: data.summary.since_last,
        }
      }
      tasks={data.tasks.map((t) => ({ id: t.id, text: t.text, owner: t.owner, done: t.done }))}
      docUrl={m.doc_id ? docUrl(m.doc_id) : null}
      notice={privatNotice((k) => tp(k as never), fel, klart)}
      toggle={setTaskDoneAction}
      deleteMeeting={deletePrivatMeetingAction}
    />
  );
}
