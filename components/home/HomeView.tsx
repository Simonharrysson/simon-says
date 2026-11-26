import { useLocale, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { meetingDayLabel, type MyTask, type RecentMeeting } from "@/lib/home/tasks";
import { MyTasks, type SaveTick, type TickState } from "./MyTasks";

/**
 * /hem, the page after sign-in: the user's own open tasks across every förening and Privat
 * ("Mina uppgifter"), then the latest meetings. Nothing here is anyone else's.
 */
export function HomeView({
  tasks,
  recent,
  unlinked,
  docs,
  today,
  save,
  initialStates,
  initialShowDone,
}: {
  tasks: MyTask[];
  recent: RecentMeeting[];
  unlinked: { id: string; name: string }[];
  docs: Record<string, string>;
  today: string;
  save?: SaveTick;
  initialStates?: Record<string, TickState>;
  initialShowDone?: boolean;
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const meetingHrefs: Record<string, string> = {};
  for (const task of tasks) {
    meetingHrefs[task.meetingId] = task.kind === "privat" ? `/privat/mote/${task.meetingId}` : `/orgs/${task.spaceId}/mote/${task.meetingId}`;
  }
  const names = new Intl.ListFormat(locale === "en" ? "en-GB" : "sv-SE", { type: "conjunction" }).format(unlinked.map((u) => u.name));

  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-10 px-gutter">
      <div className="flex flex-col gap-4">
        <PageHeader title={t("title")} meta={<p className="max-w-[34rem] text-ink-2">{t("intro")}</p>} />
        {unlinked.length > 0 && (
          <Banner tone="info" live={false} title={t("unlinkedTitle", { count: unlinked.length })}>
            <p>{t("unlinkedText", { names })}</p>
          </Banner>
        )}
        <MyTasks tasks={tasks} today={today} docs={docs} meetingHrefs={meetingHrefs} save={save} initialStates={initialStates} initialShowDone={initialShowDone} />
      </div>

      {recent.length === 0 ? (
        <EmptyState title={t("recentEmptyTitle")}>
          <p>{t("recentEmptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("recentTitle")} titleId="recent-title">
          <ul aria-labelledby="recent-title">
            {recent.map((m) => {
              const day = meetingDayLabel(m.startedAt, locale);
              const space = m.spaceKind === "privat" ? t("privat") : m.spaceName;
              const counts =
                m.decisions || m.tasks
                  ? [m.decisions ? t("decisions", { count: m.decisions }) : null, m.tasks ? t("tasks", { count: m.tasks }) : null].filter(Boolean).join(" · ")
                  : t("nothingNoted");
              return (
                <ListRow
                  key={m.id}
                  href={m.href}
                  title={m.title ?? t("meetingFallback", { day })}
                  meta={
                    <>
                      <span className="font-medium text-ink-2">{space}</span> · {day}
                      <span className="block text-ink-2">{counts}</span>
                    </>
                  }
                  actions={
                    <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                  }
                />
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}
