import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/motion/CountUp";
import { Enter } from "@/components/motion/Enter";
import { ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IconCheck, IconClock, IconExternal, IconUsers } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, panelPadClass } from "@/components/ui/Panel";
import type { OrgMeetingPage } from "@/lib/home/meeting";
import { formatDuration } from "@/lib/format";
import type { SummaryStatus } from "@/lib/meetings/recap";
import { longDay } from "@/lib/privat/format";
import { meetingDayLabel } from "@/lib/home/tasks";
import { MeetingTasks } from "./MeetingTasks";
import { MomentLink, MomentsProvider } from "./Moments";
import type { SaveTick, TickState } from "./MyTasks";

/**
 * A förening's (or Företag's) meeting in the app, and where a meeting ends (the live page comes here
 * once the notes are final): a recap (decisions, tasks, length, who was there, the summary e-mail),
 * the decisions, the tasks to tick off, and the Doc for everything else. Members who may see the
 * meeting only (the loader reads as the viewer).
 */
export function OrgMeetingView({
  page,
  today,
  save,
  initialStates,
  summary,
  justEnded = false,
  setGuestAccess,
}: {
  page: OrgMeetingPage;
  today: string;
  save?: SaveTick;
  initialStates?: Record<string, TickState>;
  /** What happened to the summary e-mail (`loadSummaryStatus`); null: unknown, nothing said. */
  summary?: SummaryStatus | null;
  /** Ended a little while ago: the recap says "Mötet är avslutat". */
  justEnded?: boolean;
  /** Admins: take a guest's access away or give it back (0067). */
  setGuestAccess?: FormAction;
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const { org, meeting, decisions, tasks } = page;
  const decisionItems = page.decisionItems ?? decisions.map((text, i) => ({ itemId: `d${i}`, text, saidAtMs: null }));
  const done = tasks.filter((x) => x.done).length;
  const anyTick = tasks.some((x) => x.canTick);
  const seconds = meeting.endedAt ? (Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt)) / 1000 : null;
  const attendees = page.attendees ?? [];
  // "De som missade mötet" only in a förening (a Företag mails the meeting's people, neutrally);
  // "mejlas strax" only right after the end (an old meeting left unsent says nothing).
  const mail =
    summary?.state === "sent"
      ? t("meeting.summarySent", { mode: summary.mode === "missed" && org.kind !== "foretag" ? "missed" : "other", count: summary.sent })
      : summary?.state === "pending" && justEnded && !meeting.isTest
        ? t("meeting.summaryPending")
        : summary?.state === "off"
          ? t("meeting.summaryOff")
          : null;
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-gutter">
      <PageHeader
        back={page.guest ? { href: "/hem", label: t("meeting.guestBack") } : { href: `/orgs/${org.id}`, label: t("meeting.back", { name: org.name }) }}
        title={meeting.title ?? t("meetingFallback", { day: meetingDayLabel(meeting.startedAt, locale) })}
        meta={
          <p className="text-ink-2">
            <span className="font-medium text-ink">{org.name}</span> · {longDay(meeting.startedAt, locale)}
          </p>
        }
        actions={
          page.docUrl && (
            <ButtonLink href={page.docUrl} target="_blank" rel="noreferrer" variant="secondary" icon={<IconExternal />} className="max-sm:w-full">
              {t("meeting.openDoc")}
            </ButtonLink>
          )
        }
      />

      {page.guest && <p className="-mt-2 text-sm text-ink-2">{t("meeting.guestNote", { org: org.name })}</p>}

      <MomentsProvider meetingId={meeting.id}>
        <Enter>
          <Panel
            title={
              justEnded ? (
                <span className="flex items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-full bg-green-wash text-green" aria-hidden="true">
                    <IconCheck size={16} />
                  </span>
                  {t("meeting.ended")}
                </span>
              ) : (
                t("meeting.recapTitle")
              )
            }
            titleId="recap-title"
          >
            <dl className="grid grid-cols-3 gap-x-4 gap-y-1 max-[24rem]:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-ink-3">{t("meeting.statDecisions")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  <CountUp text={String(decisions.length)} />
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-ink-3">{t("meeting.statTasks")}</dt>
                <dd className="flex items-baseline gap-2">
                  <CountUp className="text-2xl font-semibold tabular-nums" text={String(tasks.length)} />
                  {tasks.length > 0 && <span className="text-sm text-ink-3">{t("meeting.statDone", { count: done })}</span>}
                </dd>
              </div>
              {seconds !== null && seconds >= 0 && (
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-ink-3">{t("meeting.statDuration")}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{formatDuration(seconds, locale)}</dd>
                </div>
              )}
            </dl>
            {page.guests && page.guests.length > 0 && (
              <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
                <h3 id="guests-title" className="text-sm font-semibold">
                  {t("meeting.guestsTitle")}
                </h3>
                <p className="text-sm text-ink-2">{t("meeting.guestsHint")}</p>
                <ul aria-labelledby="guests-title" className="flex flex-col divide-y divide-line">
                  {page.guests.map((g) => {
                    const name = g.name ?? g.email;
                    return (
                      <li key={g.userId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm">
                        <span className="min-w-0 wrap-anywhere">
                          <span className={g.revoked ? "text-ink-3 line-through" : "font-medium"}>{name}</span>
                          {g.name && <span className="text-ink-3"> · {g.email}</span>}
                          {g.revoked && <span className="text-ink-3"> · {t("meeting.guestRevoked")}</span>}
                        </span>
                        {setGuestAccess && (
                          <form action={setGuestAccess}>
                            <input type="hidden" name="orgId" value={org.id} />
                            <input type="hidden" name="meetingId" value={meeting.id} />
                            <input type="hidden" name="userId" value={g.userId} />
                            <input type="hidden" name="on" value={g.revoked ? "1" : "0"} />
                            <SubmitButton variant="ghost" size="sm" aria-label={t(g.revoked ? "meeting.guestRestoreLabel" : "meeting.guestRevokeLabel", { name })}>
                              {t(g.revoked ? "meeting.guestRestore" : "meeting.guestRevoke")}
                            </SubmitButton>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {(attendees.length > 0 || mail) && (
              <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4 text-sm text-ink-2">
                {attendees.length > 0 && (
                  <p className="flex items-start gap-2 wrap-anywhere">
                    <IconUsers size={16} className="mt-[0.2rem] flex-none text-ink-3" />
                    <span>{t("meeting.attended", { names: attendees.join(", ") })}</span>
                  </p>
                )}
                {mail && (
                  <p className="flex items-start gap-2">
                    {summary?.state === "pending" ? (
                      <IconClock size={16} className="mt-[0.2rem] flex-none text-ink-3" />
                    ) : (
                      <IconCheck size={16} className={`mt-[0.2rem] flex-none ${summary?.state === "sent" ? "text-green" : "text-ink-3"}`} />
                    )}
                    <span>{mail}</span>
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel flush title={t("meeting.decisionsTitle")} titleId="decisions-title">
            <div className={panelPadClass}>
              {decisions.length ? (
                <ul aria-labelledby="decisions-title" className="list-dash flex flex-col gap-2">
                  {decisionItems.map((d) => (
                    <li key={d.itemId} className="wrap-anywhere">
                      {d.text}
                      {d.saidAtMs !== null && (
                        <>
                          {" "}
                          <MomentLink itemId={d.itemId} saidAtMs={d.saidAtMs} className="-my-0.5 ml-0.5" />
                        </>
                      )}
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
      </MomentsProvider>
    </div>
  );
}
