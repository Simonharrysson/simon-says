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
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-gutter">
      <PageHeader
        back={{ href: "/privat", label: "Privat" }}
        title={name}
        actions={
          !busy && (
            <ButtonLink href={startHref} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
              Spela in
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      <Panel title="Öppna uppgifter" titleId="open-title">
        <TaskList
          tasks={open}
          toggle={toggle}
          label="Öppna uppgifter"
          empty={meetings.length ? "Inga öppna uppgifter. Nya kommer från nästa inspelning." : "Uppgifter från dina inspelningar hamnar här."}
        />
        {done.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 text-ink-2">Klara nyligen ({done.length})</summary>
            <TaskList tasks={done} toggle={toggle} label="Klara nyligen" />
          </details>
        )}
      </Panel>

      {log.length > 0 && (
        <Panel title="Beslut och bra att veta" titleId="log-title">
          <ul aria-labelledby="log-title" className="flex list-dash flex-col gap-2 pl-[1.1rem] marker:text-ink-3">
            {log.map((e) => (
              <li key={`${e.kind}-${e.meetingId}-${e.text}`}>
                <span className="wrap-anywhere">{e.text}</span>{" "}
                <span className="text-xs whitespace-nowrap text-ink-3">
                  {e.kind === "decision" ? "Beslut" : "Fakta"} · {shortWhen(e.at)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(people.length > 0 || topics.length > 0) && (
        <Panel title="Återkommer ofta" titleId="recurring-title">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm max-[30rem]:grid-cols-1">
            {people.length > 0 && (
              <>
                <dt className="font-medium">Personer</dt>
                <dd className="text-ink-2">{people.map((p) => `${p.name} (${p.count})`).join(", ")}</dd>
              </>
            )}
            {topics.length > 0 && (
              <>
                <dt className="font-medium">Ämnen</dt>
                <dd className="text-ink-2">{topics.map((p) => `${p.name} (${p.count})`).join(", ")}</dd>
              </>
            )}
          </dl>
        </Panel>
      )}

      <Panel flush title="Inspelningar" titleId="meetings-title">
        {meetings.length === 0 ? (
          <div className={panelPadClass}>
            <EmptyState title="Inga inspelningar än">
              <p>Tryck Spela in. Sammanfattningen kommer på mejlen och hamnar här.</p>
            </EmptyState>
          </div>
        ) : (
          <ul aria-labelledby="meetings-title">
            {meetings.map((m) => (
              <ListRow
                key={m.id}
                href={m.live ? `/meetings/${m.id}` : `/privat/mote/${m.id}`}
                title={shortWhen(m.startedAt)}
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
          trigger="Radera sammanhanget"
          triggerIcon={<IconTrash size={16} />}
          disabled={busy}
          title={`Radera ${name}?`}
          description={
            <p>
              Alla {meetings.length} inspelningar i sammanhanget raderas: anteckningar, transkript, sammanfattningar och uppgifter.
              Det går inte att ångra. Google-dokument du skapat ligger kvar i Drive.
            </p>
          }
          confirmLabel="Radera sammanhanget"
          pendingLabel="Raderar…"
        />
      </div>
    </div>
  );
}

/** The line under a recording in the list. */
export function meetingLine(m: { status: string; summary: string | null; summary_state: string | null }): string {
  if (m.status === "live") return "Pågår";
  if (m.status === "ending") return "Avslutas";
  if (m.summary) return firstSentence(m.summary);
  if (m.status === "abandoned") return "Avbruten";
  if (m.summary_state === "no_notes") return "Inget hördes";
  if (m.summary_state === "failed") return "Ingen sammanfattning";
  return "Sammanfattningen kommer strax";
}
