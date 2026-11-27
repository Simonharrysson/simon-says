import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/motion/CountUp";
import { Enter } from "@/components/motion/Enter";
import { ButtonLink } from "@/components/ui/button";
import { IconExternal } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, panelPadClass } from "@/components/ui/Panel";
import type { OrgMeetingPage } from "@/lib/home/meeting";
import { longDay } from "@/lib/privat/format";
import { meetingDayLabel } from "@/lib/home/tasks";
import { MeetingTasks } from "./MeetingTasks";
import type { SaveTick, TickState } from "./MyTasks";

/**
 * A förening meeting in the app: a short summary from the stored notes (decisions; tasks with
 * who, when and klart när), and the Doc for everything else. Members only.
 */
export function OrgMeetingView({
  page,
  today,
  save,
  initialStates,
}: {
  page: OrgMeetingPage;
  today: string;
  save?: SaveTick;
  initialStates?: Record<string, TickState>;
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const { org, meeting, decisions, tasks } = page;
  const decisionsText = t("decisions", { count: decisions.length });
  const done = tasks.filter((x) => x.done).length;
  const summary = tasks.length
    ? t("meeting.summary", { decisions: decisionsText, tasks: t("tasks", { count: tasks.length }), done })
    : t("meeting.summaryNoTasks", { decisions: decisionsText });
  const anyTick = tasks.some((x) => x.canTick);
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-gutter">
      <PageHeader
        back={{ href: `/orgs/${org.id}`, label: t("meeting.back", { name: org.name }) }}
        title={meeting.title ?? t("meetingFallback", { day: meetingDayLabel(meeting.startedAt, locale) })}
        meta={
          <div className="flex flex-col gap-1 text-ink-2">
            <p>
              <span className="font-medium text-ink">{org.name}</span> · {longDay(meeting.startedAt, locale)}
            </p>
            <p>
              <CountUp text={summary} />
            </p>
          </div>
        }
        actions={
          page.docUrl && (
            <ButtonLink href={page.docUrl} target="_blank" rel="noreferrer" variant="secondary" icon={<IconExternal />} className="max-sm:w-full">
              {t("meeting.openDoc")}
            </ButtonLink>
          )
        }
      />

      <Enter>
        <Panel flush title={t("meeting.decisionsTitle")} titleId="decisions-title">
          <div className={panelPadClass}>
            {decisions.length ? (
              <ul aria-labelledby="decisions-title" className="list-dash flex flex-col gap-2">
                {decisions.map((d, i) => (
                  <li key={i} className="wrap-anywhere">
                    {d}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">{t("meeting.noDecisions")}</p>
            )}
          </div>
        </Panel>

        <Panel flush title={t("meeting.tasksTitle")} titleId="tasks-title">
          {anyTick && <p className="-mt-2 px-6 pb-2 text-sm text-ink-2">{page.isAdmin ? t("meeting.adminTickHint") : t("meeting.canTickHint")}</p>}
          {tasks.length ? (
            <div className="pb-2">
              <MeetingTasks tasks={tasks} today={today} docUrl={page.docUrl} save={save} initialStates={initialStates} />
            </div>
          ) : (
            <p className={`${panelPadClass} text-sm text-ink-3`}>{t("meeting.noTasks")}</p>
          )}
        </Panel>

        {page.docUrl && <p data-enter-item className="text-sm text-ink-3">{t("meeting.docHint")}</p>}
      </Enter>
    </div>
  );
}
