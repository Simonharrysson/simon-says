"use client";

import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface TaskItem {
  id: string;
  text: string;
  owner: string | null;
  done: boolean;
  /** One grey line under the text ("från 26 nov"). */
  meta?: string | null;
}

/**
 * Tasks with a checkbox each: ticking saves at once (no Save button), the row stays where it is
 * and is struck through, and a failed save puts it back and says so.
 */
export function TaskList({
  tasks,
  toggle,
  label,
  empty,
}: {
  tasks: TaskItem[];
  toggle: (taskId: string, done: boolean) => Promise<boolean>;
  /** The list's accessible name. */
  label: string;
  empty?: string;
}) {
  const id = useId();
  const [done, setDone] = useState<Record<string, boolean>>(() => Object.fromEntries(tasks.map((t) => [t.id, t.done])));
  const [failed, setFailed] = useState<string | null>(null);
  if (!tasks.length) return empty ? <p className="text-sm text-ink-3">{empty}</p> : null;
  const onChange = async (taskId: string, next: boolean) => {
    setFailed(null);
    setDone((d) => ({ ...d, [taskId]: next }));
    const ok = await toggle(taskId, next).catch(() => false);
    if (!ok) {
      setDone((d) => ({ ...d, [taskId]: !next }));
      setFailed(taskId);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={label} className="flex flex-col">
        {tasks.map((t) => {
          const checked = done[t.id] ?? t.done;
          return (
            <li key={t.id} className="border-t border-line first:border-t-0">
              <label htmlFor={`${id}-${t.id}`} className="grid min-h-11 cursor-pointer grid-cols-[auto_1fr] items-start gap-3 py-3">
                <Checkbox id={`${id}-${t.id}`} className="mt-[2px]" checked={checked} onCheckedChange={(on) => void onChange(t.id, on === true)} />
                <span className="flex min-w-0 flex-col gap-[0.1rem]">
                  <span className={cn("wrap-anywhere", checked && "text-ink-3 line-through")}>
                    {t.owner && <span className="font-medium">{t.owner}: </span>}
                    {t.text}
                  </span>
                  {t.meta && <span className="text-xs text-ink-3">{t.meta}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="alert" className="text-sm font-medium text-red">
          Det gick inte att spara bocken. Kontrollera nätet och försök igen.
        </p>
      )}
    </div>
  );
}
