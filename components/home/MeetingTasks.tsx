"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import type { MeetingTask } from "@/lib/home/meeting";
import { isOverdue } from "@/lib/home/tasks";
import { cn } from "@/lib/utils";
import { postTick, RowStatus, useTicks, whenLabel, type SaveTick, type TickState } from "./MyTasks";

/** The tasks of one meeting: who, when, klart när; a checkbox where the user may tick it. */
export function MeetingTasks({
  tasks,
  today,
  docUrl,
  save = postTick,
  initialStates,
}: {
  tasks: MeetingTask[];
  today: string;
  docUrl: string | null;
  save?: SaveTick;
  initialStates?: Record<string, TickState>;
}) {
  const t = useTranslations("home");
  const { states, tick, undo } = useTicks(save, initialStates);
  return (
    <ul aria-label={t("meeting.tasksTitle")} className="flex flex-col">
      {tasks.map((task) => (
        <Row key={task.key} task={task} state={states[task.key]} today={today} docUrl={docUrl} onTick={() => tick(task)} onUndo={() => undo(task)} />
      ))}
    </ul>
  );
}

function Row({
  task,
  state,
  today,
  docUrl,
  onTick,
  onUndo,
}: {
  task: MeetingTask;
  state: TickState | undefined;
  today: string;
  docUrl: string | null;
  onTick: () => void;
  onUndo: () => void;
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const id = useId();
  const checked = task.done || Boolean(state && state.kind !== "error");
  const overdue = isOverdue(task, today) && !checked;
  const when = whenLabel(t, { ...task, done: checked }, today, locale);
  const tickable = task.canTick && (!state || state.kind === "pending" || state.kind === "error");
  return (
    <li className="border-t border-line px-6 py-3 first:border-t-0 max-[30rem]:px-4">
      <div className="grid grid-cols-[auto_1fr] gap-x-3">
        {task.canTick || task.done ? (
          <label htmlFor={id} className="-m-3 flex size-11 cursor-pointer items-start justify-center p-3">
            <Checkbox
              id={id}
              checked={checked}
              disabled={!tickable}
              aria-describedby={`${id}-meta`}
              onCheckedChange={(on) => (on === true ? onTick() : onUndo())}
            />
          </label>
        ) : (
          <span aria-hidden="true" className="w-5 text-ink-3">
            –
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          {task.canTick ? (
            <label htmlFor={id} className={cn("cursor-pointer font-medium wrap-anywhere", checked && "text-ink-3 line-through")}>
              {task.text}
            </label>
          ) : (
            <p className={cn("font-medium wrap-anywhere", checked && "text-ink-3 line-through")}>{task.text}</p>
          )}
          <p id={`${id}-meta`} className="flex flex-wrap gap-x-2 text-sm text-ink-2">
            <span className={cn("font-medium", task.owner ? "text-ink" : "text-ink-3")}>{task.owner ?? t("meeting.noOwner")}</span>
            <span aria-hidden="true">·</span>
            {task.done ? (
              <span className="font-medium text-green">{t("done")}</span>
            ) : (
              <span className={cn(overdue ? "font-medium text-red" : !task.dueDate && !task.due && "text-ink-3")}>{when}</span>
            )}
          </p>
          {task.doneWhen && <p className="text-sm text-ink-2 wrap-anywhere">{t("doneWhen", { text: task.doneWhen })}</p>}
          <RowStatus state={state} docUrl={docUrl} onUndo={onUndo} />
        </div>
      </div>
    </li>
  );
}
