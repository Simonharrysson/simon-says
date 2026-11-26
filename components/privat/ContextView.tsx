import { useLocale, useTranslations } from "next-intl";
import { ButtonLink } from "@/components/ui/button";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight, IconMic, IconTrash } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, panelPadClass } from "@/components/ui/Panel";
import { NoticeBanner } from "@/components/views/NoticeBanner";
import { shortWhen } from "@/lib/privat/format";
import { firstSentence, type LogEntry, type Recurring } from "@/lib/privat/log";
import type { Notice } from "@/lib/ui/messages";
import { TaskList, type TaskItem } from "./TaskList";

export interface ContextMeeting {
  id: string;
  startedAt: string;
  /** "Pågår", "Sammanfattningen kommer strax", or the summary's first sentence. */
  line: string;
  /** Live or ending: links to the live page instead. */
  live: boolean;
}

/**
 * /privat/<context>: what the context "keeps track of" across recordings. Open tasks (tick done),
 * the decisions and key facts (newest first), people and topics that come back, and every
 * recording with its summary. Deleting the context deletes its recordings.
 */
export function ContextView({
  contextId,
  name,
  startHref,
  open,
  done,
  log,
  people,
  topics,
  meetings,
  notice,
  toggle,
  deleteContext,
  busy,
}: {
  contextId: string;
  name: string;
  startHref: string;
  open: TaskItem[];
  done: TaskItem[];
  log: LogEntry[];
  people: Recurring[];
  topics: Recurring[];
  meetings: ContextMeeting[];
  notice: Notice | null;
  toggle: (taskId: string, done: boolean) => Promise<boolean>;
  deleteContext: FormAction;
  /** A recording runs: no new one and no delete. */
  busy: boolean;
}) {
  const t = useTranslations("privat.context");
  const locale = useLocale() === "en" ? "en" : "sv";
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-gutter">
      <PageHeader
        back={{ href: "/privat", label: t("back") }}
        title={name}
        actions={
          !busy && (
            <ButtonLink href={startHref} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
              {t("start")}
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      <Panel title={t("openTitle")} titleId="open-title">
        <TaskList
          tasks={open}
          toggle={toggle}
          label={t("openTitle")}
          empty={meetings.length ? t("openEmptyAfter") : t("openEmptyBefore")}
        />
        {done.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 text-ink-2">{t("doneRecently", { count: done.length })}</summary>
            <TaskList tasks={done} toggle={toggle} label={t("doneLabel")} />
          </details>
        )}
      </Panel>

      {log.length > 0 && (
        <Panel title={t("logTitle")} titleId="log-title">
          <ul aria-labelledby="log-title" className="flex list-dash flex-col gap-2 pl-[1.1rem] marker:text-ink-3">
            {log.map((e) => (
              <li key={`${e.kind}-${e.meetingId}-${e.text}`}>
                <span className="wrap-anywhere">{e.text}</span>{" "}
                <span className="text-xs whitespace-nowrap text-ink-3">
                  {e.kind === "decision" ? t("decision") : t("fact")} · {shortWhen(e.at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(people.length > 0 || topics.length > 0) && (
        <Panel title={t("recurringTitle")} titleId="recurring-title">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm max-[30rem]:grid-cols-1">
            {people.length > 0 && (
              <>
                <dt className="font-medium">{t("people")}</dt>
                <dd className="text-ink-2">{people.map((p) => `${p.name} (${p.count})`).join(", ")}</dd>
              </>
            )}
            {topics.length > 0 && (
              <>
                <dt className="font-medium">{t("topics")}</dt>
                <dd className="text-ink-2">{topics.map((p) => `${p.name} (${p.count})`).join(", ")}</dd>
              </>
            )}
          </dl>
        </Panel>
      )}

      <Panel flush title={t("meetingsTitle")} titleId="meetings-title">
        {meetings.length === 0 ? (
          <div className={panelPadClass}>
            <EmptyState title={t("meetingsEmptyTitle")}>
              <p>{t("meetingsEmptyText")}</p>
            </EmptyState>
          </div>
        ) : (
          <ul aria-labelledby="meetings-title">
            {meetings.map((m) => (
              <ListRow
                key={m.id}
                href={m.live ? `/meetings/${m.id}` : `/privat/mote/${m.id}`}
                title={shortWhen(m.startedAt, locale)}
                meta={m.line}
                actions={
                  <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                }
              />
            ))}
          </ul>
        )}
      </Panel>

      <div>
        <ConfirmAction
          action={deleteContext}
          hidden={{ contextId }}
          trigger={t("delete")}
          triggerIcon={<IconTrash size={16} />}
          disabled={busy}
          title={t("deleteTitle", { name })}
          description={<p>{t("deleteText", { count: meetings.length })}</p>}
          confirmLabel={t("delete")}
          pendingLabel={t("deleting")}
        />
      </div>
    </div>
  );
}

/** The line under a recording in the list (`t`: privat.context). */
export function meetingLine(m: { status: string; summary: string | null; summary_state: string | null }, t: (key: string) => string): string {
  if (m.status === "live") return t("line.live");
  if (m.status === "ending") return t("line.ending");
  if (m.summary) return firstSentence(m.summary);
  if (m.status === "abandoned") return t("line.abandoned");
  if (m.summary_state === "no_notes") return t("line.noNotes");
  if (m.summary_state === "failed") return t("line.failed");
  return t("line.pending");
}
