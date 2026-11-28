import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { IconCheck, IconDoc, IconMic, IconPause, IconStop } from "@/components/ui/icons";
import { docBoxClass, docHeadingClass, docLineClass, docPaperClass, docTitleClass } from "@/components/views/doc-paper";
import { cn } from "@/lib/utils";
import { ASSISTANTS } from "./config";

// Faithful pictures of the app's own screens and mails, drawn in HTML (no images), with fictional
// content. They are decorative (aria-hidden): each section's text says the same thing in words.
// No frame inside a frame: sheets float on a tinted stage by a soft drop (no ring), and inside a
// sheet rows are divided by hairlines or tinted, never boxed.

/** A floating sheet: the app's surface lifted by an offset shadow, no ring. */
export const sheetClass =
  "rounded-xl bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06),0_12px_32px_-12px_rgb(0_0_0/0.22)] dark:bg-sunk dark:shadow-[0_1px_0_rgb(255_255_255/0.06)_inset,0_16px_40px_-16px_rgb(0_0_0/0.8)]";
/** The tinted stage a picture sits on. */
/** In the dark the stage sinks to the surface black and the sheets rise to the lighter grey. */
export const stageClass = "relative overflow-hidden rounded-2xl bg-sunk dark:bg-surface";

const label = "text-2xs font-semibold text-ink-3";

function Check({ done = false, size = "md" }: { done?: boolean; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-3.5 rounded-[3px]" : "size-4 rounded-[4px]";
  return done ? (
    <span className={cn("grid flex-none place-items-center bg-green text-on-green", box)}>
      <IconCheck size={size === "sm" ? 10 : 12} strokeWidth={2.5} />
    </span>
  ) : (
    <span className={cn("block flex-none border-[1.5px] border-control", box)} />
  );
}

/* ---------- Före, under och efter ---------- */

/** Inför möten: the short mail ten minutes before (lib/brief/email.ts). */
export function BriefMock() {
  const t = useTranslations("landing.phases");
  return (
    <div className={cn(sheetClass, "w-full max-w-[21rem] text-sm")}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid size-8 flex-none place-items-center rounded-full bg-ink font-logo text-lg leading-none text-on-ink">S</span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="font-semibold">{t("briefFrom")}</span>
          <span className="truncate text-ink-2">{t("briefSubject")}</span>
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="flex flex-col gap-0.5">
          <span className={label}>{t("briefLast")}</span>
          <span>{t("briefLastLine")}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={label}>{t("briefDecisions")}</span>
          <span className="flex items-baseline gap-2">
            <IconCheck size={14} className="flex-none translate-y-0.5 text-green" />
            {t("briefDecision")}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={label}>{t("briefOpen")}</span>
          <span className="flex items-center justify-between gap-3">
            {t("briefOpen1")}
            <span className="text-xs text-ink-3">{t("briefOpen1Meta")}</span>
          </span>
          <span className="flex items-center justify-between gap-3">
            {t("briefOpen2")}
            <span className="rounded-full bg-red-wash px-2 py-0.5 text-2xs font-medium text-red">{t("briefOpen2Meta")}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A task as the live page shows it: Vem, När, Klart när. */
export function TaskMock() {
  const t = useTranslations("landing.phases");
  const row = (name: string, value: string) => (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 border-t border-line py-2.5 text-sm">
      <span className="text-ink-3">{name}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
  return (
    <div className={cn(sheetClass, "w-full max-w-[21rem] px-4 pt-4 pb-1.5")}>
      <p className="mb-3 flex items-center gap-2.5 font-medium">
        <Check />
        {t("taskTitle")}
      </p>
      {row(t("who"), t("taskWho"))}
      {row(t("when"), t("taskWhen"))}
      {row(t("doneWhen"), t("taskDoneWhen"))}
    </div>
  );
}

/** Mina uppgifter on Hem. */
export function MyTasksMock() {
  const t = useTranslations("landing.phases");
  return (
    <div className={cn(sheetClass, "w-full max-w-[21rem] px-4 pt-4 pb-1.5")}>
      <p className="text-sm font-semibold">{t("myTasks")}</p>
      <ul className="mt-3 flex flex-col">
        <li className="flex items-start gap-3 border-t border-line py-3">
          <span className="mt-0.5">
            <Check />
          </span>
          <span className="flex flex-col">
            <span className="text-sm font-medium">{t("myTask1")}</span>
            <span className="text-xs text-ink-3">{t("myTask1Meta")}</span>
          </span>
        </li>
        <li className="flex items-start gap-3 border-t border-line py-3">
          <span className="mt-0.5">
            <Check done />
          </span>
          <span className="flex flex-col">
            <span className="text-sm text-ink-3 line-through">{t("myTask2")}</span>
            <span className="text-xs text-ink-3">{t("myTask2Meta")}</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

/* ---------- I rummet eller i Google Meet ---------- */

/** The live page's control strip on the laptop at the table. */
export function RoomMock() {
  const t = useTranslations("landing.where");
  return (
    <div className="flex w-full max-w-[24rem] flex-col items-center gap-6">
      <span className="relative grid size-24 place-items-center rounded-full bg-surface text-red dark:bg-sunk shadow-[0_1px_2px_rgb(0_0_0/0.06),0_12px_32px_-12px_rgb(0_0_0/0.22)]">
        <span className="absolute inset-[-10px] rounded-full bg-red/10" />
        <span className="absolute inset-[-22px] rounded-full bg-red/5" />
        <IconMic size={34} className="relative" />
      </span>
      <div className={cn(sheetClass, "flex w-full items-center gap-3 py-2 pr-2 pl-4 text-xs")}>
        <span className="font-mono font-medium text-red tabular-nums">{t("live")}</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">{t("partial")}</span>
        <span className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-sunk px-3 font-medium text-ink dark:bg-surface">
          <IconPause size={14} />
          {t("pause")}
        </span>
        <span className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-red-wash px-3 font-medium text-red">
          <IconStop size={12} />
          {t("end")}
        </span>
      </div>
    </div>
  );
}

/** The call setup: the shared tab and both levels heard (components/live/CallSetup.tsx). */
export function CallMock() {
  const t = useTranslations("landing.where");
  const level = (who: string, bars: number[]) => (
    <div className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
      <span className="w-20 text-sm font-medium">{who}</span>
      <span className="flex h-5 flex-1 items-end gap-[3px]">
        {bars.map((h, i) => (
          <span key={i} className="w-1 rounded-full bg-green" style={{ height: `${h}%` }} />
        ))}
      </span>
      <span className="text-xs font-medium text-green">{t("heard")}</span>
    </div>
  );
  return (
    <div className="flex w-full max-w-[24rem] flex-col gap-4">
      <div className="flex items-center gap-2 self-start rounded-full bg-surface dark:bg-sunk py-1.5 pr-4 pl-2 text-xs font-medium text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_20px_-10px_rgb(0_0_0/0.2)]">
        <span className="grid size-6 place-items-center rounded-full bg-green-wash text-green">
          <IconMic size={13} />
        </span>
        {t("tab")}
      </div>
      <div className={cn(sheetClass, "px-4 py-1")}>
        {level(t("you"), [30, 55, 80, 45, 65, 35, 50, 70, 40, 25, 45, 60])}
        {level(t("theCall"), [50, 70, 40, 85, 60, 75, 45, 55, 90, 65, 40, 55])}
      </div>
      <p className="flex items-center gap-2 text-sm text-ink-2">
        <IconCheck size={16} className="text-green" />
        {t("bothHeard")}
      </p>
    </div>
  );
}

/* ---------- Företag ---------- */

function TreeNode({ name, people, sees, seesLabel }: { name: string; people: string; sees: boolean; seesLabel: string }) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left",
        sees ? "bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06),0_10px_24px_-12px_rgb(0_0_0/0.22)] dark:bg-sunk" : "bg-board/60 text-ink-3 dark:bg-sunk/40",
      )}
    >
      <span className={cn("text-sm font-semibold", !sees && "text-ink-3")}>{name}</span>
      <span className="truncate text-xs text-ink-3">{people}</span>
      <span className={cn("mt-1 text-2xs font-medium", sees ? "text-green" : "text-ink-3")}>{seesLabel}</span>
    </div>
  );
}

/** Personer & grupper as a tree, lit up for one meeting in Utveckling, and a customer page. */
export function TreeMock() {
  const t = useTranslations("landing.foretag");
  return (
    <div className="flex w-full max-w-[34rem] flex-col gap-5">
      <p className="flex items-center gap-2 self-center rounded-full bg-surface dark:bg-sunk px-3 py-1.5 text-xs font-medium shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_20px_-10px_rgb(0_0_0/0.2)]">
        <span className="font-mono text-red">LIVE</span>
        {t("meeting")}
      </p>
      <div className="flex flex-col items-center">
        <div className="w-[min(12rem,60%)]">
          <TreeNode name={t("root")} people={t("rootPeople")} sees seesLabel={t("sees")} />
        </div>
        {/* The connectors: a stem and a bar over the three teams. */}
        <span className="h-5 w-px bg-rail" />
        <span className="h-px w-[67%] bg-rail" />
        <div className="grid w-full grid-cols-3 gap-2 min-[30rem]:gap-3">
          {(
            [
              ["g1", "g1People", true],
              ["g2", "g2People", false],
              ["g3", "g3People", false],
            ] as const
          ).map(([name, people, sees]) => (
            <div key={name} className="flex flex-col items-center">
              <span className="h-5 w-px bg-rail" />
              <div className="w-full">
                <TreeNode name={t(name)} people={t(people)} sees={sees} seesLabel={sees ? t("sees") : t("notSees")} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={cn(sheetClass, "mt-2 ml-auto w-full max-w-[20rem] p-4 text-sm min-[48rem]:-mt-1 min-[48rem]:mr-[-1rem]")}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex flex-col">
            <span className={label}>{t("customer")}</span>
            <span className="text-base font-semibold">{t("customerName")}</span>
          </span>
          <span className="text-xs text-ink-3">{t("customerDomain")}</span>
        </div>
        <p className="mt-2 text-ink-2">
          {t("customerMeetings")} · {t("customerLast")}
        </p>
        <p className="mt-3 flex items-center gap-2.5 border-t border-line pt-3">
          <Check size="sm" />
          <span className="flex-1">{t("customerOpen")}</span>
          <span className="text-xs text-ink-3">{t("customerOpenMeta")}</span>
        </p>
      </div>
    </div>
  );
}

/* ---------- Föreningar ---------- */

/** Förbered möte's agenda Doc, the format chip and the Nästa möte card on Möten. */
export function AgendaMock() {
  const t = useTranslations("landing.foreningar");
  return (
    <div className="relative w-full max-w-[30rem] pt-2 pb-24">
      <div className={cn(docPaperClass, "w-[min(100%,24rem)] -rotate-1")}>
        <p className={docTitleClass}>{t("agenda")}</p>
        <ol className="mt-3 flex flex-col gap-1.5 [counter-reset:item] [&>li]:[counter-increment:item] [&>li]:before:mr-2 [&>li]:before:text-[#5f6368] [&>li]:before:content-[counter(item)'.']">
          <li>{t("agenda1")}</li>
          <li>
            {t("agenda2")}
            <span className="mt-1 ml-5 flex flex-col gap-1 text-[#3c4043]">
              <span className={docLineClass}>
                <span className={docBoxClass} />
                {t("agenda2a")}
              </span>
              <span className={docLineClass}>
                <span className="font-bold text-[#137333]">✓</span>
                {t("agenda2b")}
              </span>
            </span>
          </li>
          <li>
            {t("agenda3")}
            <span className="mt-1 ml-5 flex text-[#3c4043]">{t("agenda3a")}</span>
          </li>
          <li>{t("agenda4")}</li>
        </ol>
        <p className={cn(docHeadingClass, "mt-5")}>{t("format")}</p>
        <p className="mt-1 text-[0.85em] text-[#5f6368]">{t("formatFrom")}</p>
      </div>
      <div className={cn(sheetClass, "absolute right-0 bottom-0 flex w-[15rem] flex-col gap-1 p-4 text-sm min-[48rem]:right-[-0.5rem]")}>
        <span className={label}>{t("next")}</span>
        <span className="font-semibold">{t("nextWhen")}</span>
        <span className="flex items-center gap-2 text-green">
          <IconCheck size={14} />
          {t("nextReady")}
        </span>
      </div>
    </div>
  );
}

/* ---------- Privat ---------- */

/** Privat: contexts, and the summary mail after a sales call. */
export function PrivatMock() {
  const t = useTranslations("landing.privat");
  return (
    <div className="flex w-full max-w-[28rem] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-1 text-ink-3">{t("contexts")}</span>
        <span className="rounded-full bg-ink px-3 py-1.5 font-medium text-on-ink">{t("context1")}</span>
        <span className="rounded-full bg-surface dark:bg-sunk px-3 py-1.5 text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/0.08)]">{t("context2")}</span>
        <span className="rounded-full bg-surface dark:bg-sunk px-3 py-1.5 text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/0.08)]">{t("context3")}</span>
      </div>
      <div className={cn(sheetClass, "overflow-hidden")}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid size-9 flex-none place-items-center rounded-full bg-ink font-logo text-xl leading-none text-on-ink">S</span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">{t("mailFrom")}</span>
            <span className="truncate text-sm text-ink-2">{t("mailSubject")}</span>
          </span>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 text-sm">
          <div className="flex flex-col gap-1">
            <p className={label}>{t("mailSummary")}</p>
            <p className="text-ink-2">{t("mailSummaryText")}</p>
          </div>
          <div className="flex flex-col gap-2">
            <p className={label}>{t("mailTasks")}</p>
            <p className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <Check size="sm" />
              </span>
              {t("mailTask1")}
            </p>
            <p className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <Check size="sm" />
              </span>
              {t("mailTask2")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Din AI ---------- */

/** A question to a connected assistant, answered with its source. */
export function ChatMock() {
  const t = useTranslations("landing.ai");
  return (
    <div className="flex w-full max-w-[34rem] flex-col gap-4">
      <div className="flex items-start gap-3 self-end">
        <p className="rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-on-ink">{t("question")}</p>
      </div>
      <div className={cn(sheetClass, "flex flex-col gap-3 p-5 text-sm leading-relaxed")}>
        <p>{t("answer")}</p>
        <p className="inline-flex items-center gap-2 self-start rounded-md bg-sunk px-2.5 py-1.5 text-xs font-medium text-ink-2">
          <IconDoc size={14} />
          {t("source")}
        </p>
      </div>
    </div>
  );
}

/** The assistants you can connect, with whether it works today (config.ts). */
export function AssistantTiles() {
  const t = useTranslations("landing.ai");
  return (
    <ul aria-label={t("toolsLabel")} className="grid grid-cols-2 gap-3">
      {ASSISTANTS.map((a) => (
        <li key={a.name} className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-panel">
          <span aria-hidden="true" className="grid size-10 flex-none place-items-center rounded-lg bg-sunk font-mono text-xs font-medium text-ink">
            {a.mark}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{a.name}</span>
            <span className={cn("text-xs", a.status === "live" ? "font-medium text-green" : "text-ink-3")}>{a.status === "live" ? t("live") : t("soon")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A section's picture on its tinted stage. With `label` it is a figure whose picture is described
 * by that text; without, the section's own text says it all and the stage is hidden from
 * assistive tech.
 */
export function Stage({ label: alt, children, className }: { label?: string; children: ReactNode; className?: string }) {
  const cls = cn(stageClass, "reveal grid place-items-center px-[clamp(1rem,4vw,3rem)] py-[clamp(2rem,5vw,4rem)]", className);
  if (!alt) {
    return (
      <div aria-hidden="true" className={cls}>
        {children}
      </div>
    );
  }
  return (
    <figure role="img" aria-label={alt} className={cls}>
      {children}
    </figure>
  );
}
