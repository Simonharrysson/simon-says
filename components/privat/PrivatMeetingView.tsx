import { ButtonLink } from "@/components/ui/button";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { Banner } from "@/components/ui/Banner";
import { IconExternal, IconTrash } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { NoticeBanner } from "@/components/views/NoticeBanner";
import { sinceLastWord } from "@/lib/privat/email";
import { longDay, shortWhen } from "@/lib/privat/format";
import { sinceLastOrder, type SinceLastItem } from "@/lib/privat/since-last";
import type { Notice } from "@/lib/ui/messages";
import { cn } from "@/lib/utils";
import { TaskList, type TaskItem } from "./TaskList";

export interface PrivatMeetingSummary {
  summary: string;
  decisions: string[];
  facts: string[];
  questions: string[];
  sinceLast: SinceLastItem[];
}

/** "pending": not summarised yet; "none": nothing was heard; "failed": the summary could not be made. */
export type SummaryStatus = "ready" | "pending" | "none" | "failed";

/**
 * /privat/mote/<id>: one recording and its summary (what the e-mail said, with the tasks tickable).
 * "Radera inspelningen" removes its notes, transcript, summary and tasks.
 */
export function PrivatMeetingView({
  meetingId,
  context,
  startedAt,
  status,
  summary,
  tasks,
  docUrl,
  notice,
  toggle,
  deleteMeeting,
}: {
  meetingId: string;
  context: { id: string; name: string };
  startedAt: string;
  status: SummaryStatus;
  summary: PrivatMeetingSummary | null;
  tasks: TaskItem[];
  docUrl: string | null;
  notice: Notice | null;
  toggle: (taskId: string, done: boolean) => Promise<boolean>;
  deleteMeeting: FormAction;
}) {
  const section = (title: string, items: string[]) =>
    items.length > 0 && (
      <Panel title={title} titleId={`${title}-title`}>
        <ul aria-labelledby={`${title}-title`} className="flex list-dash flex-col gap-2 pl-[1.1rem] marker:text-ink-3">
          {items.map((t) => (
            <li key={t} className="wrap-anywhere">
              {t}
            </li>
          ))}
        </ul>
      </Panel>
    );
  const since = summary ? sinceLastOrder(summary.sinceLast) : [];
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-gutter">
      <PageHeader
        back={{ href: `/privat/${context.id}`, label: context.name }}
        title={shortWhen(startedAt)}
        meta={<p className="text-ink-2 first-letter:uppercase">{longDay(startedAt)}</p>}
        actions={
          docUrl && (
            <ButtonLink href={docUrl} target="_blank" rel="noopener noreferrer" variant="secondary" icon={<IconExternal size={18} />}>
              Google-dokumentet
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      {status === "pending" && (
        <Banner tone="info" title="Sammanfattningen kommer strax" live={false}>
          Den skrivs ungefär en minut efter att inspelningen avslutats och kommer också på mejlen. Ladda om sidan om en stund.
        </Banner>
      )}
      {status === "none" && (
        <Banner tone="neutral" title="Inget att sammanfatta" live={false}>
          Inspelningen innehöll inget tal som gick att skriva ner.
        </Banner>
      )}
      {status === "failed" && (
        <Banner tone="warning" title="Sammanfattningen kunde inte skrivas" live={false}>
          Inspelningen sparades, men sammanfattningen blev inte av. Du kan radera inspelningen om du inte behöver den.
        </Banner>
      )}

      {summary && (
        <Panel title="Sammanfattning" titleId="summary-title">
          <p className="text-ink-2">{summary.summary}</p>
        </Panel>
      )}
      {tasks.length > 0 && (
        <Panel title="Uppgifter" titleId="tasks-title">
          <TaskList tasks={tasks} toggle={toggle} label="Uppgifter från inspelningen" />
        </Panel>
      )}
      {summary && section("Beslut", summary.decisions)}
      {summary && section("Öppna frågor", summary.questions)}
      {since.length > 0 && (
        <Panel title="Sedan sist" titleId="since-title">
          <ul aria-labelledby="since-title" className="flex flex-col gap-2">
            {since.map((s) => (
              <li key={s.taskId} className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="wrap-anywhere">
                  {s.text}
                  {s.owner && <span className="text-ink-3"> ({s.owner})</span>}
                </span>
                <span className={cn("text-sm font-medium", s.status === "done" ? "text-green" : "text-ink-3")}>{sinceLastWord("sv", s.status)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {summary && section("Bra att komma ihåg", summary.facts)}

      <div>
        <ConfirmAction
          action={deleteMeeting}
          hidden={{ meetingId, contextId: context.id }}
          trigger="Radera inspelningen"
          triggerIcon={<IconTrash size={16} />}
          title="Radera inspelningen?"
          description={
            <p>
              Anteckningar, transkript, sammanfattning och uppgifter från inspelningen raderas. Det går inte att ångra.
              {docUrl ? " Google-dokumentet ligger kvar i Drive." : ""}
            </p>
          }
          confirmLabel="Radera inspelningen"
          pendingLabel="Raderar…"
        />
      </div>
    </div>
  );
}
