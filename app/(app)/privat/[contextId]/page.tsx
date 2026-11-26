import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
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
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("privat"))("metaTitle"), robots: { index: false, follow: false } };
}

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
  const t = await getTranslations("privat");
  const locale = (await getLocale()) === "en" ? "en" : "sv";
  const busy = data.meetings.some((m) => m.status === "live" || m.status === "ending");
  const from = new Map(data.meetings.map((m) => [m.id, m.started_at]));
  const toItem = (task: (typeof data.open)[number]) => ({
    id: task.id,
    text: task.text,
    owner: task.owner,
    done: task.done,
    meta: t("context.taskFrom", { when: shortWhen(from.get(task.meeting_id) ?? task.created_at, locale) }),
  });
  return (
    <ContextView
      contextId={data.context.id}
      name={data.context.name}
      startHref={`/meetings/ny/${data.context.org_id}?sammanhang=${data.context.id}`}
      open={data.open.map(toItem)}
      done={data.done.map(toItem)}
      log={decisionLog(data.summaries)}
      people={recurring(data.summaries, "people")}
      topics={recurring(data.summaries, "topics")}
      meetings={data.meetings.map((m) => ({
        id: m.id,
        startedAt: m.started_at,
        line: meetingLine(m, (k) => t(`context.${k}` as never)),
        live: m.status === "live" || m.status === "ending",
      }))}
      notice={privatNotice((k) => t(k as never), fel, klart)}
      toggle={setTaskDoneAction}
      deleteContext={deleteContextAction}
      busy={busy}
    />
  );
}
