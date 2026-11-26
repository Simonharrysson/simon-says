"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { dueDayLabel, isOverdue, meetingDayLabel, nextDay, type MyTask } from "@/lib/home/tasks";
import { cn } from "@/lib/utils";

// The task list of Mina uppgifter. Ticking a task shows it done at once, with "Ångra" for 5
// seconds; only then is it saved (so undo never has to take "✓ klart" back out of a Doc). A tick
// still waiting when the page closes is sent right away (keepalive). After saving, the row says
// what happened in the Doc: written, or "Bocka av i dokumentet också" with a link.

export const UNDO_MS = 5000;

export type DocOutcome = "written" | "locked" | "none" | "failed";
export type TickState =
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; doc: DocOutcome }
  | { kind: "error"; code: "save" | "forbidden" | "not_open" };

/** Saves one tick; the default posts to /api/mina-uppgifter/klart. */
export type SaveTick = (task: MyTask, opts: { keepalive: boolean }) => Promise<{ ok: true; doc: DocOutcome } | { ok: false; code: "save" | "forbidden" | "not_open" }>;

export const postTick: SaveTick = async (task, { keepalive }) => {
  const body = task.kind === "note" ? { kind: "note", meetingId: task.meetingId, itemId: task.itemId } : { kind: "privat", taskId: task.itemId };
  try {
    const res = await fetch("/api/mina-uppgifter/klart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; doc?: DocOutcome; error?: string } | null;
    if (res.ok && json?.ok) return { ok: true, doc: json.doc ?? "none" };
    return { ok: false, code: json?.error === "forbidden" ? "forbidden" : json?.error === "not_open" ? "not_open" : "save" };
  } catch {
    return { ok: false, code: "save" };
  }
};

/** Done tasks shown under "Visa klara" (the newest meetings first). */
export const MAX_DONE_SHOWN = 30;

export function MyTasks({
  tasks,
  today,
  docs,
  meetingHrefs,
  save = postTick,
  initialStates,
  initialShowDone = false,
}: {
  tasks: MyTask[];
  /** YYYY-MM-DD in Stockholm, from the server (so overdue agrees with the server render). */
  today: string;
  /** Doc URL per förening meeting id. */
  docs: Record<string, string>;
  /** In-app page per meeting id. */
  meetingHrefs: Record<string, string>;
  save?: SaveTick;
  /** /design only: rows already in a state. */
  initialStates?: Record<string, TickState>;
  initialShowDone?: boolean;
}) {
  const t = useTranslations("home");
  const locale = useLocale() === "en" ? "en" : "sv";
  const [filter, setFilter] = useState<string>("all");
  const [showDone, setShowDone] = useState(initialShowDone);
  const { states, tick, undo } = useTicks(save, initialStates);
  const switchId = useId();

  // Ticked here: shown as done (until saving failed). Done from the server: only with "Visa klara".
  const doneHere = (task: MyTask) => {
    const st = states[task.key];
    return Boolean(st && st.kind !== "error");
  };
  const openTasks = tasks.filter((x) => !x.done);
  const spaces = useMemo(() => {
    const out = new Map<string, { id: string; name: string; count: number }>();
    for (const x of tasks) {
      if (x.done) continue;
      const name = x.spaceKind === "privat" ? t("privat") : x.spaceName;
      const s = out.get(x.spaceId) ?? { id: x.spaceId, name, count: 0 };
      s.count++;
      out.set(x.spaceId, s);
    }
    return [...out.values()];
  }, [tasks, t]);
  const chips = [{ id: "all", name: t("all"), count: openTasks.length }, ...spaces];
  const inFilter = (x: MyTask) => filter === "all" || x.spaceId === filter;
  const doneShown = tasks
    .filter((x) => x.done)
    .sort((a, b) => b.meetingAt.localeCompare(a.meetingAt))
    .slice(0, MAX_DONE_SHOWN);
  const visible = [...openTasks, ...(showDone ? doneShown : [])].filter(inFilter);
  const filterName = spaces.find((s) => s.id === filter)?.name ?? "";
  const hasDone = tasks.some((x) => x.done);

  const shownOpen = openTasks.filter(inFilter);
  const overdueCount = shownOpen.filter((x) => isOverdue(x, today) && !doneHere(x)).length;

  return (
    <div className="flex flex-col gap-4">
      {(spaces.length > 1 || hasDone) && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          {spaces.length > 1 ? (
            <>
              {/* Phones: one labelled select (the phone's own picker); wider screens: every space as a toggle. */}
              <label className="flex w-full flex-col gap-1 text-sm font-medium md:hidden">
                {t("filterLabel")}
                <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {chips.map((s) => (
                    <option key={s.id} value={s.id}>
                      {t("chip", { name: s.name, count: s.count })}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <div role="group" aria-label={t("filterLabel")} className="flex flex-wrap gap-2 max-md:hidden">
                {chips.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={filter === s.id}
                    onClick={() => setFilter(s.id)}
                    className={cn(
                      "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors duration-120",
                      filter === s.id ? "border-ink bg-ink text-on-ink" : "border-control bg-surface text-ink hover:bg-sunk",
                    )}
                  >
                    {t("chip", { name: s.name, count: s.count })}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <span />
          )}
          {hasDone && (
            <label htmlFor={switchId} className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
              <Switch id={switchId} checked={showDone} onCheckedChange={setShowDone} />
              {t("showDone")}
            </label>
          )}
        </div>
      )}

      {shownOpen.length > 0 && (
        <p className="text-sm text-ink-2" aria-live="polite">
          {t("openCount", { count: shownOpen.filter((x) => !doneHere(x)).length })}
          {overdueCount > 0 && (
            <>
              {" · "}
              <span className="font-medium text-red">{t("overdueCount", { count: overdueCount })}</span>
            </>
          )}
        </p>
      )}
      {visible.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-rail px-6 py-8 text-ink-2">
          {filter !== "all" ? (
            <p className="text-base font-semibold text-ink">{t("filterEmpty", { name: filterName })}</p>
          ) : (
            <>
              <p className="text-base font-semibold text-ink">{hasDone ? t("allDoneTitle") : t("emptyTitle")}</p>
              <p className="max-w-[34rem] text-sm">{hasDone ? t("allDoneText") : t("emptyText")}</p>
            </>
          )}
        </div>
      ) : (
        <ul aria-label={t("listLabel")} className="flex flex-col rounded-lg bg-surface shadow-panel">
          {visible.map((task) => (
            <TaskRow
              key={task.key}
              task={task}
              state={states[task.key]}
              checked={task.done || doneHere(task)}
              today={today}
              locale={locale}
              docUrl={docs[task.meetingId] ?? null}
              meetingHref={meetingHrefs[task.meetingId] ?? null}
              onTick={() => tick(task)}
              onUndo={() => undo(task)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ticks with a 5 s undo, saved when the time runs out (or right away when the page closes). */
export function useTicks(save: SaveTick, initialStates?: Record<string, TickState>) {
  const [states, setStates] = useState<Record<string, TickState>>(initialStates ?? {});
  const timers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; task: MyTask }>());

  const commit = useCallback(
    async (task: MyTask, keepalive: boolean) => {
      timers.current.delete(task.key);
      setStates((s) => ({ ...s, [task.key]: { kind: "saving" } }));
      const res = await save(task, { keepalive });
      setStates((s) => ({ ...s, [task.key]: res.ok ? { kind: "saved", doc: res.doc } : { kind: "error", code: res.code } }));
    },
    [save],
  );

  // Leaving the page (or this list) sends what still waits for its undo time.
  useEffect(() => {
    const pending = timers.current;
    const flush = () => {
      for (const { timer, task } of [...pending.values()]) {
        clearTimeout(timer);
        void commit(task, true);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commit]);

  const tick = (task: MyTask) => {
    setStates((s) => ({ ...s, [task.key]: { kind: "pending" } }));
    const timer = setTimeout(() => void commit(task, false), UNDO_MS);
    timers.current.set(task.key, { timer, task });
  };
  const undo = (task: MyTask) => {
    const p = timers.current.get(task.key);
    if (p) clearTimeout(p.timer);
    timers.current.delete(task.key);
    setStates((s) => {
      const next = { ...s };
      delete next[task.key];
      return next;
    });
  };

  return { states, tick, undo };
}

/** "Senast fre 4 dec" / "Senast imorgon" / "Försenad, skulle vara klar …" / "När: till nästa möte" / "Ingen deadline". */
export function whenLabel(
  t: ReturnType<typeof useTranslations<"home">>,
  task: Pick<MyTask, "dueDate" | "due" | "done">,
  today: string,
  locale: "sv" | "en",
): string {
  if (task.dueDate) {
    if (isOverdue(task, today)) return t("overdue", { day: dueDayLabel(task.dueDate, locale) });
    if (task.dueDate === today) return t("dueToday");
    if (task.dueDate === nextDay(today)) return t("dueTomorrow");
    return t("due", { day: dueDayLabel(task.dueDate, locale) });
  }
  return task.due ? t("dueText", { due: task.due }) : t("noDue");
}

function TaskRow({
  task,
  state,
  checked,
  today,
  locale,
  docUrl,
  meetingHref,
  onTick,
  onUndo,
}: {
  task: MyTask;
  state: TickState | undefined;
  checked: boolean;
  today: string;
  locale: "sv" | "en";
  docUrl: string | null;
  meetingHref: string | null;
  onTick: () => void;
  onUndo: () => void;
}) {
  const t = useTranslations("home");
  const id = useId();
  const overdue = isOverdue(task, today) && !checked;
  const when = whenLabel(t, { ...task, done: checked }, today, locale);
  const space = task.spaceKind === "privat" ? (task.contextName ? `${t("privat")} · ${task.contextName}` : t("privat")) : task.spaceName;
  const from = t(task.kind === "privat" ? "fromRecording" : "fromMeeting", { day: meetingDayLabel(task.meetingAt, locale) });
  const locked = task.done || (state !== undefined && state.kind !== "pending" && state.kind !== "error");

  return (
    <li className="border-t border-line px-4 py-3 first:border-t-0 sm:px-6">
      <div className="grid grid-cols-[auto_1fr] gap-x-3">
        {/* The checkbox's touch target is the whole 44px square around it. */}
        <label htmlFor={id} className="-m-3 flex size-11 cursor-pointer items-start justify-center p-3">
          <Checkbox
            id={id}
            checked={checked}
            disabled={locked}
            aria-describedby={`${id}-meta`}
            onCheckedChange={(on) => (on === true ? onTick() : onUndo())}
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={id} className={cn("cursor-pointer font-medium wrap-anywhere", checked && "text-ink-3 line-through")}>
            {task.text}
          </label>
          <p id={`${id}-meta`} className="text-sm">
            {task.done ? (
              <span className="font-medium text-green">{t("done")}</span>
            ) : (
              <span className={cn(overdue ? "font-medium text-red" : task.dueDate || task.due ? "text-ink" : "text-ink-3")}>{when}</span>
            )}
          </p>
          {task.doneWhen && <p className="text-sm text-ink-2 wrap-anywhere">{t("doneWhen", { text: task.doneWhen })}</p>}
          <p className="text-xs text-ink-3">
            <span className="font-medium text-ink-2">{space}</span>
            {" · "}
            {meetingHref ? (
              <a href={meetingHref} className="text-ink-3 underline-offset-2 hover:text-ink">
                {from}
              </a>
            ) : (
              from
            )}
          </p>
          <RowStatus state={state} docUrl={docUrl} onUndo={onUndo} />
        </div>
      </div>
    </li>
  );
}

export function RowStatus({ state, docUrl, onUndo }: { state: TickState | undefined; docUrl: string | null; onUndo: () => void }) {
  const t = useTranslations("home");
  if (!state) return null;
  const docLink = docUrl && (
    <a href={docUrl} target="_blank" rel="noreferrer" className="font-medium">
      {t("openDoc")}
    </a>
  );
  return (
    <div role="status" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {state.kind === "pending" && (
        <>
          <span className="text-green">{t("justDone")}</span>
          <button type="button" onClick={onUndo} className="inline-flex min-h-11 items-center font-medium text-blue underline underline-offset-2 md:min-h-0">
            {t("undo")}
          </button>
        </>
      )}
      {state.kind === "saving" && <span className="text-ink-3">{t("saving")}</span>}
      {state.kind === "saved" && state.doc === "written" && <span className="text-green">{t("docWritten")}</span>}
      {state.kind === "saved" && state.doc === "none" && <span className="text-green">{t("done")}</span>}
      {state.kind === "saved" && (state.doc === "locked" || state.doc === "failed") && (
        <>
          <span className="text-ink">{t.rich(state.doc === "locked" ? "docLocked" : "docFailed", { strong: (chunks) => <strong className="font-semibold">{chunks}</strong> })}</span>
          {docLink}
        </>
      )}
      {state.kind === "error" && (
        <span role="alert" className="font-medium text-red">
          {t(state.code === "forbidden" ? "forbidden" : state.code === "not_open" ? "notOpen" : "saveFailed")}
        </span>
      )}
    </div>
  );
}
