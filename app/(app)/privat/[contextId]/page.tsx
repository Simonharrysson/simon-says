import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContextView, meetingLine } from "@/components/privat/ContextView";
import { isUuid } from "@/lib/db/ids";
import { shortWhen } from "@/lib/privat/format";
import { decisionLog, recurring } from "@/lib/privat/log";
import { loadContextPage } from "@/lib/privat/load";
import { privatNotice } from "@/lib/privat/messages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deleteContextAction, setTaskDoneAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privat", robots: { index: false, follow: false } };

export default async function PrivatContextPage({
  params,
  searchParams,
}: {
  params: Promise<{ contextId: string }>;
  searchParams: Promise<{ fel?: string; klart?: string }>;
}) {
  const { contextId } = await params;
  const { fel, klart } = await searchParams;
  if (!isUuid(contextId)) notFound();
  const db = await createSupabaseServerClient();
  // As the user: RLS shows only their own space's contexts.
  const data = await loadContextPage(db, contextId);
  if (!data) notFound();
  const busy = data.meetings.some((m) => m.status === "live" || m.status === "ending");
  const from = new Map(data.meetings.map((m) => [m.id, m.started_at]));
  const task = (t: (typeof data.open)[number]) => ({
    id: t.id,
    text: t.text,
    owner: t.owner,
    done: t.done,
    meta: `från ${shortWhen(from.get(t.meeting_id) ?? t.created_at)}`,
  });
  return (
    <ContextView
      contextId={data.context.id}
      name={data.context.name}
      startHref={`/meetings/ny/${data.context.org_id}?sammanhang=${data.context.id}`}
      open={data.open.map(task)}
      done={data.done.map(task)}
      log={decisionLog(data.summaries)}
      people={recurring(data.summaries, "people")}
      topics={recurring(data.summaries, "topics")}
      meetings={data.meetings.map((m) => ({
        id: m.id,
        startedAt: m.started_at,
        line: meetingLine(m),
        live: m.status === "live" || m.status === "ending",
      }))}
      notice={privatNotice(fel, klart)}
      toggle={setTaskDoneAction}
      deleteContext={deleteContextAction}
      busy={busy}
    />
  );
}
