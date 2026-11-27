"use client";

import { useTranslations } from "next-intl";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { IconStop } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  endAnswers,
  endReady,
  endStats,
  type EndDrafts,
  type EndHandled as Handled,
  type EndStats,
  type TaskAnswer,
  type TaskField,
  type TaskView,
} from "@/lib/notes/tasks";
import { taskText } from "./TasksPanel";

/** Typed and handled so far in the dialog; kept across Esc / Fortsätt mötet. */
export interface EndProgress {
  handled: Record<string, Handled | undefined>;
  drafts: EndDrafts;
}
export const NO_PROGRESS: EndProgress = { handled: {}, drafts: {} };

/** What Avsluta asks about (GET /api/meetings/[id]/tasks), for a förening that asks. */
export interface EndAsk {
  /** The incomplete tasks; empty: Avsluta asks the usual question instead. */
  tasks: TaskView[];
  /** Names to suggest for Vem (the meeting's speakers): suggestions only, never filled in. */
  owners?: string[];
  /** Admins: turn the question off (false) or back on (true) for the förening. True when saved. */
  setAsking?: (on: boolean) => Promise<boolean>;
}

/**
 * Avsluta with incomplete tasks (the förening asks for Vem, När and Klart när). A gentle offer,
 * never a gate: "Avsluta ändå" ends at once with whatever is filled in; a task can be filled in
 * (Enter saves; Vem and När suggest) or left as it is. Typed but unsaved fields are sent too.
 * Admins get "Fråga inte igen i den här föreningen", with Ångra, right here (inside the modal,
 * so it stays reachable).
 */
export function EndTasksDialog({
  open,
  onOpenChange,
  tasks,
  owners = [],
  setAsking,
  progress,
  onProgress,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: TaskView[];
  owners?: string[];
  setAsking?: (on: boolean) => Promise<boolean>;
  /** What is typed and handled so far, kept by the parent so closing and reopening keeps it. */
  progress: EndProgress;
  onProgress: (update: (cur: EndProgress) => EndProgress) => void;
  onConfirm: (answers: TaskAnswer[], stats: EndStats) => void;
}) {
  const t = useTranslations("tasks.end");
  const listId = useId();
  const { handled, drafts } = progress;
  const [asking, setAskingState] = useState<"on" | "off" | "busy">("on");
  const [askFailed, setAskFailed] = useState(false);
  // After a change of the setting, focus follows it: to Ångra once off, back to the link once on.
  const moved = useRef(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const offRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moved.current || asking === "busy") return;
    moved.current = false;
    (asking === "off" ? undoRef : offRef).current?.focus();
  }, [asking]);
  const ready = endReady(tasks, handled);
  const whenSuggestions = t.raw("whenSuggestions") as string[];

  const changeAsking = async (on: boolean) => {
    if (!setAsking) return;
    setAskingState("busy");
    setAskFailed(false);
    const ok = await setAsking(on).catch(() => false);
    moved.current = ok;
    setAskFailed(!ok);
    setAskingState(ok === on ? "on" : "off");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="end-tasks" className="max-w-[40rem]">
        <DialogBody>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("intro", { count: tasks.length })}</DialogDescription>
          <datalist id={`${listId}-owner`}>
            {owners.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <datalist id={`${listId}-due`}>
            {whenSuggestions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <ul className="-mx-1 mt-2 flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-1" aria-label={t("title")}>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                listId={listId}
                handled={handled[task.id]}
                values={drafts[task.id] ?? {}}
                onValues={(v) => onProgress((cur) => ({ ...cur, drafts: { ...cur.drafts, [task.id]: v } }))}
                onHandled={(h) => onProgress((cur) => ({ ...cur, handled: { ...cur.handled, [task.id]: h } }))}
              />
            ))}
          </ul>
          {setAsking && (
            <div className="mt-3 text-sm">
              {/* The live region holds only the message; the buttons stay outside it. */}
              <p className="sr-only" role="status" aria-live="polite">
                {askFailed ? t("turnOffFailed") : asking === "off" ? t("turnedOff") : ""}
              </p>
              {asking === "off" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-sunk px-3 py-2">
                  <span aria-hidden="true">{t("turnedOff")}</span>
                  <Button ref={undoRef} size="sm" variant="ghost" onClick={() => void changeAsking(true)}>
                    {t("turnOn")}
                  </Button>
                </div>
              ) : (
                <button
                  ref={offRef}
                  type="button"
                  className="text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                  disabled={asking === "busy"}
                  onClick={() => void changeAsking(false)}
                >
                  {t("turnOff")}
                </button>
              )}
              {askFailed && (
                <p className="mt-1 text-ink-2" aria-hidden="true">
                  {t("turnOffFailed")}
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
            {t("stay")}
          </Button>
          <Button
            variant="danger"
            icon={<IconStop size={16} />}
            onClick={() => {
              const answers = endAnswers(tasks, handled, drafts);
              onOpenChange(false);
              onConfirm(answers, endStats(tasks, handled, answers));
            }}
          >
            {ready ? t("confirm") : t("endAnyway")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({
  task,
  listId,
  handled,
  values,
  onValues,
  onHandled,
}: {
  task: TaskView;
  listId: string;
  handled: Handled | undefined;
  values: Partial<Record<TaskField, string>>;
  onValues: (values: Partial<Record<TaskField, string>>) => void;
  onHandled: (h: Handled | undefined) => void;
}) {
  const t = useTranslations("tasks.end");
  const p = useTranslations("tasks.panel");
  const id = useId();
  const labels: Record<TaskField, string> = { owner: p("who"), due: p("when"), doneWhen: p("doneWhen") };
  const hints: Record<TaskField, string> = { owner: t("whoHint"), due: t("whenHint"), doneWhen: t("doneWhenHint") };
  const lists: Partial<Record<TaskField, string>> = { owner: `${listId}-owner`, due: `${listId}-due` };
  const complete = task.missing.every((f) => values[f]?.trim());
  const empty = task.missing.filter((f) => !values[f]?.trim());
  // Set by a save with fields still empty: they are marked and named, never a silent nothing.
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
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
            if (complete) return onHandled({ kind: "completed", values });
            setTried(true);
            formRef.current?.querySelector<HTMLInputElement>(`#${CSS.escape(`${id}-${empty[0]}`)}`)?.focus();
          }}
          ref={formRef}
        >
          {task.missing.map((f) => (
            <div key={f} className="flex flex-col gap-1">
              <Label htmlFor={`${id}-${f}`}>{labels[f]}</Label>
              <Input
                id={`${id}-${f}`}
                value={values[f] ?? ""}
                placeholder={hints[f]}
                maxLength={200}
                list={lists[f]}
                autoComplete="off"
                enterKeyHint="done"
                aria-invalid={tried && !values[f]?.trim() ? true : undefined}
                aria-describedby={tried && empty.length ? `${id}-missing` : undefined}
                onChange={(event) => onValues({ ...values, [f]: event.target.value })}
              />
            </div>
          ))}
          {tried && empty.length > 0 && (
            <p id={`${id}-missing`} className="text-sm text-ink-2" role="status">
              {t("stillMissing", { fields: empty.map((f) => labels[f].toLowerCase()).join(", ") })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="primary">
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
