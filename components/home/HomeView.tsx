import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/motion/CountUp";
import { Enter } from "@/components/motion/Enter";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { meetingDayLabel, type MyTask, type RecentMeeting } from "@/lib/home/tasks";
import { MyTasks, type SaveTick, type TickState } from "./MyTasks";
import { HandoffApprovals } from "./HandoffApprovals";
import type { PendingHandoff } from "@/lib/home/tasks";

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
  bare,
  approvals = [],
}: {
  tasks: MyTask[];
  recent: RecentMeeting[];
  unlinked: { id: string; name: string }[];
  docs: Record<string, string>;
  today: string;
  save?: SaveTick;
  initialStates?: Record<string, TickState>;
  initialShowDone?: boolean;
  /** Only the content under the title, for a page that renders the title itself (/hem). */
  bare?: boolean;
  /** Företag (0050): tasks waiting for this user's approval before their owner sees them. */
  approvals?: PendingHandoff[];
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const meetingHrefs: Record<string, string> = {};
  for (const task of tasks) {
    // A reviewed Företag task (0050) has no meeting to link.
    if (task.kind === "handoff") continue;
    meetingHrefs[task.meetingId] = task.kind === "privat" ? `/privat/mote/${task.meetingId}` : `/orgs/${task.spaceId}/mote/${task.meetingId}`;
  }
  const names = new Intl.ListFormat(locale === "en" ? "en-GB" : "sv-SE", { type: "conjunction" }).format(unlinked.map((u) => u.name));

  // On a client navigation (not a page load) the content rises in, row by row, and the counts count up.
  const body = (
    <Enter>
        {unlinked.length > 0 && (
          <Banner
            tone="info"
            live={false}
            title={t("unlinkedTitle", { count: unlinked.length })}
            action={
              unlinked.length === 1 ? (
                <ButtonLink href={`/orgs/${unlinked[0].id}/vem`} size="sm" icon={<IconArrowRight />}>
                  {t("unlinkedPick")}
                </ButtonLink>
              ) : undefined
            }
          >
            <p>{t("unlinkedText", { names })}</p>
            {unlinked.length > 1 && (
              // One "Välj ditt namn" per förening: each has its own people list.
              <ul className="mt-2 flex flex-wrap gap-2">
                {unlinked.map((u) => (
                  <li key={u.id}>
                    <ButtonLink href={`/orgs/${u.id}/vem`} size="sm" icon={<IconArrowRight />}>
                      {t("unlinkedPickIn", { name: u.name })}
                    </ButtonLink>
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {approvals.length > 0 && <HandoffApprovals items={approvals} />}
        <section aria-labelledby="my-tasks-title" className="flex flex-col gap-4">
          <div data-enter-item className="flex flex-col gap-1">
            <h2 id="my-tasks-title" className="text-lg tracking-[-0.02em]">
              {t("tasksTitle")}
            </h2>
            <p className="max-w-[34rem] text-ink-2">{t("intro")}</p>
          </div>
          <MyTasks tasks={tasks} today={today} docs={docs} meetingHrefs={meetingHrefs} save={save} initialStates={initialStates} initialShowDone={initialShowDone} />
        </section>

      {/* mt-6 on the column's gap-4: the 40px between Mina uppgifter and Senaste mötena. */}
      {recent.length === 0 ? (
        <div data-enter-item className="mt-6">
          <EmptyState title={t("recentEmptyTitle")}>
            <p>{t("recentEmptyText")}</p>
          </EmptyState>
        </div>
      ) : (
        <Panel flush title={t("recentTitle")} titleId="recent-title" className="mt-6">
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
                      <CountUp className="block text-ink-2" text={counts} />
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
    </Enter>
  );
  if (bare) return body;
  return (
    <HomeColumn>
      <PageHeader title={t("title")} />
      {body}
    </HomeColumn>
  );
}

/** /hem's page column. */
export function HomeColumn({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-4 px-gutter">{children}</div>;
}
