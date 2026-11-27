"use client";

import { useTranslations } from "next-intl";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskField, TaskView } from "@/lib/notes/tasks";
import { cn } from "@/lib/utils";

/** The question the room is asked for what a task lacks. */
export function askKey(missing: TaskField[]): "askOwnerDue" | "askDoneWhen" {
  return missing.includes("owner") || missing.includes("due") ? "askOwnerDue" : "askDoneWhen";
}

/** The task's own words, without our "☐ " marker (a locked line is the human's whole line). */
export const taskText = (t: Pick<TaskView, "text">) => t.text.replace(/^☐\s*/, "");

/**
 * "Uppgifter" on the live page (concrete tasks): this meeting's tasks with Vem / När / Klart
 * när. A task that lacks something shows one calm question; "Fråga nu" makes it big, for the
 * chair to read out, until "Klar". No status dots: the words carry it.
 */
export function TasksPanel({ tasks }: { tasks: TaskView[] }) {
  const t = useTranslations("tasks.panel");
  const [asking, setAsking] = useState<string | null>(null);
  const open = tasks.filter((x) => x.missing.length > 0).length;

  return (
    <section className="flex flex-col overflow-hidden rounded-lg bg-surface shadow-panel" aria-labelledby="tasks-title">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <h2 id="tasks-title" className="text-lg tracking-[-0.02em]">
          {t("title")}
        </h2>
        {open > 0 && <Badge tone="info">{t("toAsk", { count: open })}</Badge>}
      </div>
      {tasks.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-ink-3">{t("empty")}</p>
      ) : (
        <ul aria-label={t("title")}>
          {tasks.map((task) => {
            const big = asking === task.id;
            const lacks = task.missing.length > 0;
            return (
              <li key={task.id} className={cn("flex flex-col gap-2 border-t border-line px-6 py-3", big && "bg-blue-wash")}>
                <span className="font-semibold">{taskText(task)}</span>
                {task.locked ? (
                  <span className="text-sm text-ink-3">{t("editedInDoc")}</span>
                ) : (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-sm">
                    <Field label={t("who")} value={task.owner} missing={t("missing")} />
                    <Field label={t("when")} value={task.due} missing={t("missing")} />
                    <Field label={t("doneWhen")} value={task.doneWhen} missing={t("missing")} />
                  </dl>
                )}
                {lacks && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={cn("text-ink-2", big ? "text-xl font-semibold text-ink" : "text-sm")}>{t(askKey(task.missing))}</p>
                    <Button size="sm" variant={big ? "primary" : "secondary"} onClick={() => setAsking(big ? null : task.id)} aria-pressed={big}>
                      {big ? t("asked") : t("askNow")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Field({ label, value, missing }: { label: string; value: string | null; missing: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className={cn("min-w-0 break-words", !value && "text-ink-3 italic")}>{value ?? missing}</dd>
    </>
  );
}
