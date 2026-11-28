"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconMail, IconPause, IconPlay } from "@/components/ui/icons";
import { docAttendClass, docBoxClass, docHeadingClass, docLiveClass, docPaperClass, docTitleClass } from "@/components/views/doc-paper";
import { cn } from "@/lib/utils";

/**
 * The hero's product demo, drawn in code: what people say arrives as captions, and the Google Doc
 * fills in with Beslut and Att göra (Vem, När, Klart när); a task is ticked off and the summary
 * mail goes out. Then it loops.
 *
 * - Every row sits at its final place from the first paint and only its clip-path, opacity or
 *   transform changes, so nothing ever shifts (CLS 0) and the server HTML is the meeting's start.
 * - One step timer drives it. It stops offscreen (IntersectionObserver), in a hidden tab and when
 *   the visitor presses Pausa (WCAG 2.2.2: moving content gets a pause).
 * - Reduced motion: the finished meeting, still. CSS shows it before hydration too.
 * Fictional people and content; the figure says so.
 */

/** When each piece appears (the step it turns on at). */
const AT = { c1: 1, d1: 2, c2: 3, t1: 4, c3: 5, t2: 6, c4: 7, d2: 8, c5: 9, tick: 10, mail: 11 } as const;
const FINAL = 11;
/** The step after FINAL: everything fades out before the loop starts over. */
const FADE = 12;
/** How long each step is held, in ms (index = step). */
const HOLD = [900, 1500, 1300, 1700, 1400, 1500, 1400, 1600, 1300, 1600, 1300, 4200, 500];

const CAPTIONS = [1, 2, 3, 4, 5] as const;
const CAPTION_AT = [AT.c1, AT.c2, AT.c3, AT.c4, AT.c5];

/** A Doc line written in like a marker stroke (clip-path), fully visible without motion. */
const writeClass =
  "[clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-700 ease-[var(--ease-out)] data-[on=true]:[clip-path:inset(0)] motion-reduce:[clip-path:inset(0)]";

export function HeroDemo() {
  const t = useTranslations("landing.demo");
  const ref = useRef<HTMLElement>(null);
  const [step, setStep] = useState(0);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    const el = ref.current;
    const io = el ? new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 }) : null;
    if (el && io) io.observe(el);
    return () => {
      mq.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, []);

  const running = inView && visible && !paused && !reduced;

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setStep((s) => (s >= FADE ? 0 : s + 1)), HOLD[step]);
    return () => window.clearTimeout(id);
  }, [running, step]);

  const shown = reduced ? FINAL : step;
  const on = (at: number) => shown >= at;
  const currentCaption = CAPTION_AT.reduce((cur, at, i) => (shown >= at ? i + 1 : cur), 0);

  return (
    <figure ref={ref} className="flex flex-col gap-3" aria-label={t("label")}>
      <div
        data-step={shown}
        aria-hidden="true"
        className={cn(
          "relative grid grid-cols-[minmax(0,1fr)] gap-[clamp(0.75rem,2vw,1.5rem)] rounded-2xl bg-sunk dark:bg-surface p-[clamp(0.75rem,2.5vw,2.5rem)] min-[60rem]:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]",
          // The reset: the finished meeting fades out, the blank Doc fades back in, and the rows
          // jump back to hidden while it is invisible (no un-writing).
          "transition-opacity duration-400 ease-[var(--ease-out)] data-[step='12']:opacity-0 [&[data-step='0']_*]:transition-none",
        )}
      >
        {/* The live page on the laptop: what was just said, as captions. */}
        <div className="flex flex-col gap-4 rounded-xl bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.18)] min-[60rem]:p-5 dark:bg-sunk dark:shadow-[0_1px_0_rgb(255_255_255/0.06)_inset]">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs font-medium text-red tabular-nums">LIVE 14:32</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{t("room")}</span>
            <MicBars running={running} />
          </div>
          <ol className="grid min-h-[4.75rem] grid-cols-[minmax(0,1fr)] min-[60rem]:gap-4">
            {CAPTIONS.map((n, i) => {
              const at = CAPTION_AT[i];
              const state = shown < at ? "future" : currentCaption === n ? "current" : "past";
              const words = t(`c${n}`).split(" ");
              return (
                <li
                  key={n}
                  data-state={state}
                  data-last={n === 5 ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-0.5 transition-opacity duration-300 [grid-area:1/1] min-[60rem]:[grid-area:auto]",
                    "data-[state=future]:opacity-0 max-[60rem]:data-[state=past]:opacity-0 min-[60rem]:data-[state=past]:text-ink-3",
                    // Reduced motion: the whole conversation (the last line only on a phone).
                    "motion-reduce:opacity-100 max-[60rem]:motion-reduce:not-data-[last=true]:opacity-0",
                  )}
                >
                  <span className="text-xs font-semibold text-blue">{t(`s${n}`)}</span>
                  <span className="text-sm leading-snug">
                    {words.map((w, wi) => (
                      <span
                        key={wi}
                        data-on={state !== "future"}
                        style={{ transitionDelay: state === "future" ? "0ms" : `${wi * 55}ms` }}
                        className="inline-block translate-y-1 opacity-0 blur-[2px] transition-[opacity,translate,filter] duration-300 ease-[var(--ease-out)] data-[on=true]:translate-y-0 data-[on=true]:opacity-100 data-[on=true]:blur-none motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:blur-none"
                      >
                        {w}
                        {wi < words.length - 1 ? " " : ""}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* The Google Doc, writing itself. */}
        <div className={cn(docPaperClass, "relative min-[60rem]:px-[clamp(1.5rem,3vw,3rem)] min-[60rem]:pt-10 min-[60rem]:pb-12 min-[60rem]:text-[0.9375rem]")}>
          <p className={docTitleClass}>{t("docTitle")}</p>
          <p className={docLiveClass}>{t("docLive")}</p>
          <p className={docAttendClass}>{t("attendance")}</p>

          <p className={docHeadingClass}>{t("decisions")}</p>
          <DocLine on={on(AT.d1)}>
            <span className="font-bold text-[#137333]">✓</span>
            <span>{t("d1")}</span>
          </DocLine>
          <DocLine on={on(AT.d2)}>
            <span className="font-bold text-[#137333]">✓</span>
            <span>{t("d2")}</span>
          </DocLine>

          <p className={docHeadingClass}>{t("tasks")}</p>
          <TaskLine on={on(AT.t1)} who={t("t1Who")} what={t("t1What")} when={t("t1When")} doneLabel={t("doneWhen")} done={t("t1Done")} />
          <TaskLine
            on={on(AT.t2)}
            ticked={on(AT.tick)}
            tickable
            who={t("t2Who")}
            what={t("t2What")}
            when={t("t2When")}
            doneLabel={t("doneWhen")}
            done={t("t2Done")}
            doneMark={t("doneMark")}
          />
        </div>

        {/* The summary goes out. */}
        <div
          data-on={on(AT.mail)}
          className="pointer-events-none flex translate-y-3 justify-self-end min-[60rem]:absolute min-[60rem]:right-[clamp(1.25rem,4vw,3.5rem)] min-[60rem]:bottom-[clamp(1.25rem,3vw,2.75rem)] scale-[0.97] items-center gap-3 rounded-full bg-ink py-2.5 pr-5 pl-3 text-on-ink opacity-0 shadow-[0_10px_30px_-10px_rgb(0_0_0/0.45)] transition-[opacity,translate,scale] duration-[var(--dur-spring)] ease-[var(--ease-spring)] data-[on=true]:translate-y-0 data-[on=true]:scale-100 data-[on=true]:opacity-100 motion-reduce:translate-y-0 motion-reduce:scale-100 motion-reduce:opacity-100"
        >
          <span className="grid size-8 place-items-center rounded-full bg-green text-on-green">
            <IconMail size={16} />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">{t("mailTitle")}</span>
            <span className="text-xs opacity-75">{t("mailTo")}</span>
          </span>
        </div>
      </div>

      <figcaption className="flex min-h-11 items-center justify-between gap-4 text-xs text-ink-3">
        <span>{t("caption")}</span>
        {!reduced && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            className="press inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-xs font-medium text-ink-2 hover:bg-sunk hover:text-ink"
          >
            {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            {paused ? t("play") : t("pause")}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function DocLine({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <p data-on={on} className={cn("mt-[0.45em] flex items-baseline gap-[0.6em]", writeClass)}>
      {children}
    </p>
  );
}

/** A task as the Doc writes it: "Omar: skriv pressmeddelandet (fre 7 mars) – klart när: …". */
function TaskLine({
  on,
  ticked = false,
  tickable = false,
  who,
  what,
  when,
  doneLabel,
  done,
  doneMark,
}: {
  on: boolean;
  ticked?: boolean;
  /** This task is ticked in the finished meeting (the reduced-motion picture shows it ticked). */
  tickable?: boolean;
  who: string;
  what: string;
  when: string;
  doneLabel: string;
  done: string;
  doneMark?: string;
}) {
  return (
    <p data-on={on} className={cn("mt-[0.45em] flex items-baseline gap-[0.6em]", writeClass)}>
      <span className="relative inline-grid size-[0.85em] flex-none translate-y-[0.1em] place-items-center">
        <span data-on={ticked} className={cn(docBoxClass, "size-full transition-opacity duration-200 data-[on=true]:opacity-0", tickable && "motion-reduce:opacity-0")} />
        <span
          data-on={ticked}
          className={cn(
            "absolute inset-0 grid scale-50 place-items-center rounded-[2px] bg-[#137333] text-white opacity-0 transition-[opacity,scale] duration-[var(--dur-spring)] ease-[var(--ease-spring)] data-[on=true]:scale-100 data-[on=true]:opacity-100",
            tickable && "motion-reduce:scale-100 motion-reduce:opacity-100",
          )}
        >
          <IconCheck size={10} strokeWidth={3} />
        </span>
      </span>
      <span data-on={ticked} className={cn("transition-colors duration-300 data-[on=true]:text-[#5f6368]", tickable && "motion-reduce:text-[#5f6368]")}>
        <span className="font-semibold">{who}</span>: <span data-on={ticked} className={cn("decoration-[#5f6368] data-[on=true]:line-through", tickable && "motion-reduce:line-through")}>{what}</span>{" "}
        <span className="text-[#5f6368]">({when})</span> <span className="text-[#5f6368]">– {doneLabel}</span> {done}
        {doneMark && (
          <span data-on={ticked} className="ml-[0.5em] font-semibold text-[#137333] opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100 motion-reduce:opacity-100">
            {doneMark}
          </span>
        )}
      </span>
    </p>
  );
}

/** The mic level, as five bars that breathe while the demo runs (decorative). */
function MicBars({ running }: { running: boolean }) {
  return (
    <span className="flex h-4 items-center gap-[3px]">
      {[0.55, 0.9, 0.7, 1, 0.6].map((h, i) => (
        <span
          key={i}
          style={{ height: `${h * 100}%`, animationDelay: `${i * 120}ms`, animationPlayState: running ? "running" : "paused" }}
          className="w-[3px] origin-center animate-[mic-bar_900ms_ease-in-out_infinite_alternate] rounded-full bg-red motion-reduce:animate-none"
        />
      ))}
    </span>
  );
}
