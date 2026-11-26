"use client";

import { useTranslations } from "next-intl";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { IconStop } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { endAnswers, endReady, type EndHandled as Handled, type TaskAnswer, type TaskField, type TaskView } from "@/lib/notes/tasks";
import { taskText } from "./TasksPanel";

/**
 * Avsluta with incomplete tasks (the förening requires Vem, När and Klart när): each must be
 * completed inline (written to the Doc by the final pass) or left as it is. "Avsluta mötet" is
 * enabled once every task is handled; "Fortsätt mötet" is the safe, focused choice.
 */
export function EndTasksDialog({
  open,
  onOpenChange,
  tasks,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: TaskView[];
  onConfirm: (answers: TaskAnswer[]) => void;
}) {
  const t = useTranslations("tasks.end");
  const [handled, setHandled] = useState<Record<string, Handled | undefined>>({});
  const left = tasks.filter((x) => !handled[x.id]).length;
  const ready = endReady(tasks, handled);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="end-tasks" className="max-w-[40rem]">
        <DialogBody>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("intro", { count: tasks.length })}</DialogDescription>
          <ul className="-mx-1 mt-2 flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-1" aria-label={t("title")}>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                handled={handled[task.id]}
                onHandled={(h) => setHandled((cur) => ({ ...cur, [task.id]: h }))}
              />
            ))}
          </ul>
          <p className="mt-2 text-sm text-ink-2" role="status">
            {left > 0 ? t("remaining", { count: left }) : t("allHandled")}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
            {t("stay")}
          </Button>
          <Button
            variant="danger"
            icon={<IconStop size={16} />}
            disabled={!ready}
            onClick={() => {
              onOpenChange(false);
              onConfirm(endAnswers(tasks, handled));
            }}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({ task, handled, onHandled }: { task: TaskView; handled: Handled | undefined; onHandled: (h: Handled | undefined) => void }) {
  const t = useTranslations("tasks.end");
  const p = useTranslations("tasks.panel");
  const id = useId();
  const [values, setValues] = useState<Partial<Record<TaskField, string>>>(handled?.kind === "completed" ? handled.values : {});
  const labels: Record<TaskField, string> = { owner: p("who"), due: p("when"), doneWhen: p("doneWhen") };
  const hints: Record<TaskField, string> = { owner: t("whoHint"), due: t("whenHint"), doneWhen: t("doneWhenHint") };
  const complete = task.missing.every((f) => values[f]?.trim());
  const text = taskText(task);

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line p-4" aria-label={text}>
      <span className="font-semibold">{text}</span>
      {handled ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-ink-2">
            {handled.kind === "completed"
              ? `${t("saved")}: ${task.missing.map((f) => `${labels[f]} ${handled.values[f]}`).join(", ")}`
              : t("left")}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onHandled(undefined)}>
            {t("undo")}
          </Button>
        </div>
      ) : task.locked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-3">{t("editedInDoc")}</span>
          <Button size="sm" onClick={() => onHandled({ kind: "dismissed" })}>
            {t("leave")}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) onHandled({ kind: "completed", values });
          }}
        >
          {task.missing.map((f) => (
            <div key={f} className="flex flex-col gap-1">
              <Label htmlFor={`${id}-${f}`}>{labels[f]}</Label>
              <Input
                id={`${id}-${f}`}
                value={values[f] ?? ""}
                placeholder={hints[f]}
                maxLength={200}
                onChange={(event) => setValues((cur) => ({ ...cur, [f]: event.target.value }))}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!complete}>
              {t("save")}
            </Button>
            <Button type="button" size="sm" onClick={() => onHandled({ kind: "dismissed" })}>
              {t("leave")}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
