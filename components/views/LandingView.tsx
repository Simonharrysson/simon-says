import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ButtonLink, buttonVariants } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconCheck, IconGoogle, IconPause, IconStop } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cn } from "@/lib/utils";
import {
  docAttendClass,
  docBoxClass,
  docCheckClass,
  docHeadingClass,
  docLineClass,
  docLiveClass,
  docNowClass,
  docPaperClass,
  docTitleClass,
} from "./doc-paper";

const REPO = "https://github.com/Simonharrysson/simon-says";

export interface LandingViewProps {
  /** Signed-in user, if any. */
  user: { email: string; id: string } | null;
  signIn: FormAction;
}

const sectionY = "py-[clamp(4rem,9vw,7.5rem)]";
const h2Class = "max-w-[20ch] text-[clamp(1.875rem,1.3rem+2vw,2.75rem)] leading-[1.08] tracking-[-0.04em] text-balance";
const eyebrowClass = "text-sm font-medium text-ink-3";

/**
 * The public front page: föreningar first (the hero and "före, under, efter"), Privat second, then
 * how it works, the trust points and one call to action. Mockups are drawn in HTML/CSS after the
 * real UI (no images), hidden from screen readers, with their text in the catalog.
 */
export function LandingView({ user, signIn }: LandingViewProps) {
  const t = useTranslations("landing");
  return (
    <>
      <section className="pt-[clamp(2rem,6vw,5rem)] pb-[clamp(2.5rem,5vw,4rem)]" aria-labelledby="hero-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-[clamp(2rem,5vw,4.5rem)] px-gutter max-[60rem]:grid-cols-[minmax(0,1fr)]">
          <div className="flex flex-col gap-6">
            <p className={eyebrowClass}>{t("eyebrow")}</p>
            <h1 id="hero-title" className="-mt-2 text-display leading-[1.05] font-semibold tracking-[-0.045em] [overflow-wrap:break-word] hyphens-manual">
              {t("heroTitle")}
            </h1>
            <p className="max-w-[38rem] text-lg text-ink-2">{t("heroText")}</p>
            <div className="flex flex-wrap gap-2 max-[30rem]:[&>*]:w-full max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full">
              <PrimaryAction user={user} signIn={signIn} />
              <a className={buttonVariants({ variant: "ghost", size: "lg" })} href="#sa-funkar-det">
                {t("howItWorks")}
              </a>
            </div>
            <p className="text-sm text-ink-3">{user ? t("signedInAs", { email: user.email }) : t("freeLine")}</p>
          </div>

          <BoardDemo />
        </div>
      </section>

      <section id="foreningar" className={sectionY} aria-labelledby="org-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <div className="flex max-w-[40rem] flex-col gap-3">
            <p className={eyebrowClass}>{t("orgEyebrow")}</p>
            <h2 id="org-title" className={h2Class}>
              {t("orgTitle")}
            </h2>
            <p className="text-lg text-ink-2">{t("orgText")}</p>
          </div>
          <ol className="mt-12 grid grid-cols-3 gap-[clamp(1rem,2vw,1.5rem)] max-[56rem]:grid-cols-1">
            <Phase title={t("beforeTitle")} text={t("beforeText")}>
              <AgendaMock />
            </Phase>
            <Phase title={t("duringTitle")} text={t("duringText")}>
              <TaskMock />
            </Phase>
            <Phase title={t("afterTitle")} text={t("afterText")}>
              <MyTasksMock />
            </Phase>
          </ol>
        </div>
      </section>

      <section id="privat" className={cn("bg-sunk", sectionY)} aria-labelledby="privat-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-[clamp(2.5rem,6vw,5rem)] px-gutter max-[56rem]:grid-cols-1">
          <div className="reveal flex flex-col gap-4">
            <p className={eyebrowClass}>{t("privatEyebrow")}</p>
            <h2 id="privat-title" className={h2Class}>
              {t("privatTitle")}
            </h2>
            <p className="max-w-[36rem] text-lg text-ink-2">{t("privatText")}</p>
            <ul className="mt-2 flex flex-col gap-2 text-ink-2">
              {(["privatPoint1", "privatPoint2", "privatPoint3"] as const).map((key) => (
                <li key={key} className="flex items-center gap-3">
                  <IconCheck size={18} className="flex-none text-green" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
          <MailMock />
        </div>
      </section>

      <section id="sa-funkar-det" className={cn("scroll-mt-16", sectionY)} aria-labelledby="steps-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="steps-title" className={h2Class}>
            {t("stepsTitle")}
          </h2>
          <ol className="mt-12 grid grid-cols-3 gap-[clamp(1.5rem,3vw,2.5rem)] max-md:grid-cols-1">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} className="reveal flex flex-col gap-2 border-t border-ink pt-4">
                <span className="font-mono text-sm text-ink-3 tabular-nums" aria-hidden="true">
                  0{n}
                </span>
                <h3 className="text-lg tracking-[-0.015em]">{t(`step${n}Title`)}</h3>
                <p className="text-ink-2">{t(`step${n}Text`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={cn("border-t border-line", sectionY)} aria-labelledby="trust-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="trust-title" className={h2Class}>
            {t("trustTitle")}
          </h2>
          <dl className="mt-12 grid grid-cols-4 gap-x-8 gap-y-10 max-[60rem]:grid-cols-2 max-[34rem]:grid-cols-1 [&_dd]:text-ink-2 [&_dt]:text-lg [&_dt]:font-semibold [&_dt]:tracking-[-0.01em]">
            <Trust title={t("trust1Title")}>{t("trust1Text")}</Trust>
            <Trust title={t("trust2Title")}>{t("trust2Text")}</Trust>
            <Trust title={t("trust3Title")}>{t("trust3Text")}</Trust>
            <Trust title={t("trust4Title")}>{t.rich("trust4Text", { link: (chunks) => <a href="/integritet">{chunks}</a> })}</Trust>
          </dl>
          <p className="mt-12 max-w-[48rem] text-sm text-ink-3 [&_a]:text-ink-2">
            {t.rich("openLine", {
              repo: (chunks) => <a href={REPO}>{chunks}</a>,
              status: (chunks) => <a href="/status">{chunks}</a>,
            })}
          </p>
        </div>
      </section>

      <section className={cn("border-t border-line", sectionY)} aria-labelledby="close-title">
        <div className="mx-auto flex w-full max-w-page flex-col items-start gap-4 px-gutter max-[30rem]:[&_button]:w-full max-[30rem]:[&>div]:w-full max-[30rem]:[&_a]:w-full">
          <h2 id="close-title" className="text-[clamp(2.25rem,1.5rem+3vw,3.75rem)] leading-[1.05] tracking-[-0.045em]">
            {t("closeTitle")}
          </h2>
          <p className="text-lg text-ink-2">{t("closeText")}</p>
          <div className="mt-2">
            <PrimaryAction user={user} signIn={signIn} />
          </div>
        </div>
      </section>
    </>
  );
}

/** The one call to action: "Kom igång med Google", or the way in when already signed in. */
function PrimaryAction({ user, signIn }: LandingViewProps) {
  const t = useTranslations("landing");
  const login = useTranslations("login");
  if (user) {
    return (
      <ButtonLink href="/orgs" variant="primary" size="lg" icon={<IconArrowRight />}>
        {t("toOrgs")}
      </ButtonLink>
    );
  }
  return (
    <form action={signIn}>
      <input type="hidden" name="next" value="/hem" />
      <SubmitButton variant="primary" size="lg" icon={<IconGoogle />} pendingLabel={login("sendingToGoogle")}>
        {t("signIn")}
      </SubmitButton>
    </form>
  );
}

function Trust({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="reveal flex flex-col gap-2 border-t border-rail pt-4">
      <dt>{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One phase of a förening's week: a drawn piece of the real UI above its title and text. */
function Phase({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <li className="reveal flex flex-col overflow-hidden rounded-lg bg-surface shadow-panel">
      <div className="flex min-h-60 items-center justify-center border-b min-[56rem]:h-[19rem] border-line bg-board px-[clamp(1rem,3vw,1.5rem)] py-6" aria-hidden="true">
        {children}
      </div>
      <div className="flex flex-col gap-2 p-[clamp(1.25rem,3vw,1.75rem)]">
        <h3 className="text-lg tracking-[-0.015em]">{title}</h3>
        <p className="text-ink-2">{text}</p>
      </div>
    </li>
  );
}

/** Förbered möte: the agenda Doc with last week's tasks already in it. */
function AgendaMock() {
  const t = useTranslations("landing");
  return (
    <div className={cn(docPaperClass, "w-full max-w-[20rem] -rotate-1 text-[0.8125rem]")}>
      <p className={cn(docHeadingClass, "mt-0")}>{t("mock.agenda")}</p>
      <ol className="mt-2 flex flex-col gap-1 [counter-reset:item] [&>li]:[counter-increment:item] [&>li]:before:mr-2 [&>li]:before:text-[#5f6368] [&>li]:before:content-[counter(item)'.']">
        <li>{t("mock.agenda1")}</li>
        <li>
          {t("mock.agenda2")}
          <span className="mt-1 ml-5 flex flex-col gap-1 text-[#3c4043]">
            <span className="flex items-baseline gap-2">
              <span className={docBoxClass} />
              {t("doc.todo1")}
            </span>
            <span className="flex items-baseline gap-2">
              <span className={docCheckClass}>✓</span>
              {t("doc.todo2")}
            </span>
          </span>
        </li>
        <li>{t("mock.agenda3")}</li>
        <li>{t("mock.agenda4")}</li>
      </ol>
    </div>
  );
}

/** A task during the meeting: Vem, När, Klart när, as on the live page. */
function TaskMock() {
  const t = useTranslations("landing");
  const row = (label: string, value: string) => (
    <div className="grid grid-cols-[6rem_1fr] gap-2 border-t border-line py-2 text-sm">
      <span className="text-ink-3">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
  return (
    <div className="w-full max-w-[20rem] rounded-md bg-surface p-4 shadow-lift">
      <p className="mb-3 flex items-center gap-2 font-medium">
        <span className="size-4 flex-none rounded-[4px] border-[1.5px] border-control" />
        {t("mock.taskTitle")}
      </p>
      {row(t("mock.who"), t("mock.taskWho"))}
      {row(t("mock.when"), t("mock.taskWhen"))}
      {row(t("mock.doneWhen"), t("mock.taskDoneWhen"))}
    </div>
  );
}

/** Mina uppgifter: each person's own list after the meeting. */
function MyTasksMock() {
  const t = useTranslations("landing");
  return (
    <div className="w-full max-w-[20rem] rounded-md bg-surface p-4 shadow-lift">
      <p className="text-sm font-semibold">{t("mock.myTasks")}</p>
      <ul className="mt-3 flex flex-col">
        <li className="flex items-start gap-3 border-t border-line py-2.5">
          <span className="mt-0.5 size-4 flex-none rounded-[4px] border-[1.5px] border-control" />
          <span className="flex flex-col">
            <span className="text-sm font-medium">{t("mock.myTask1")}</span>
            <span className="text-xs text-ink-3">{t("mock.myTask1Meta")}</span>
          </span>
        </li>
        <li className="flex items-start gap-3 border-t border-line py-2.5">
          <span className="mt-0.5 grid size-4 flex-none place-items-center rounded-[4px] bg-green text-on-green">
            <IconCheck size={12} />
          </span>
          <span className="flex flex-col">
            <span className="text-sm text-ink-3 line-through">{t("mock.myTask2")}</span>
            <span className="text-xs text-ink-3">{t("mock.myTask2Meta")}</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

/** Privat: the summary e-mail after a recording, with the recording's context. */
function MailMock() {
  const t = useTranslations("landing");
  return (
    <figure className="reveal flex flex-col gap-3" aria-label={t("mock.mailLabel")}>
      <div className="flex flex-wrap items-center gap-2 text-xs" aria-hidden="true">
        <span className="text-ink-3">{t("mock.contexts")}</span>
        <span className="rounded-full bg-ink px-3 py-1 font-medium text-on-ink">{t("mock.context1")}</span>
        <span className="rounded-full bg-surface px-3 py-1 text-ink-2 shadow-panel">{t("mock.context2")}</span>
        <span className="rounded-full bg-surface px-3 py-1 text-ink-2 shadow-panel">{t("mock.context3")}</span>
      </div>
      <div className="overflow-hidden rounded-lg bg-surface shadow-lift" aria-hidden="true">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid size-9 flex-none place-items-center rounded-full bg-ink font-logo text-xl leading-none text-on-ink">S</span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">{t("mock.mailFrom")}</span>
            <span className="truncate text-sm text-ink-2">{t("mock.mailSubject")}</span>
          </span>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 text-sm">
          <div className="flex flex-col gap-1">
            <p className="text-2xs font-semibold tracking-[0.06em] text-ink-3 uppercase">{t("mock.mailSummary")}</p>
            <p className="text-ink-2">{t("mock.mailSummaryText")}</p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-2xs font-semibold tracking-[0.06em] text-ink-3 uppercase">{t("mock.mailTasks")}</p>
            <p className="flex items-center gap-2">
              <span className="size-3.5 flex-none rounded-[3px] border-[1.5px] border-control" />
              {t("mock.mailTask1")}
            </p>
            <p className="flex items-center gap-2">
              <span className="size-3.5 flex-none rounded-[3px] border-[1.5px] border-control" />
              {t("mock.mailTask2")}
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}

/**
 * The hero's proof: a Doc pinned to the board, writing itself, and the laptop's control
 * strip under it. Synthetic example content, labelled as such. Lines reveal once, like a
 * marker stroke (clip-path), and are fully visible without motion.
 */
function BoardDemo() {
  const t = useTranslations("landing");
  return (
    <figure className="relative flex flex-col gap-4 rounded-lg bg-sunk px-[clamp(1rem,3vw,2.25rem)] pt-[clamp(1.25rem,3vw,2.25rem)] pb-4 shadow-panel" aria-label={t("demoLabel")}>
      <div className="relative">
        <div className={docPaperClass}>
          <p className={docTitleClass}>{t("doc.title")}</p>
          <p className={docLiveClass}>{t("doc.live")}</p>
          <p className={cn(docAttendClass, "animate-write [animation-delay:0.3s] motion-reduce:animate-none")}>{t("doc.attendance")}</p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:1.0s] motion-reduce:animate-none")}>{t("doc.decisions")}</p>
          <p className={cn(docLineClass, "animate-write [animation-delay:1.4s] motion-reduce:animate-none")}>
            <span className={docCheckClass} aria-hidden="true">
              ✓
            </span>
            {t("doc.decision1")}
          </p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:2.4s] motion-reduce:animate-none")}>{t("doc.todo")}</p>
          <p className={cn(docLineClass, "animate-write [animation-delay:2.8s] motion-reduce:animate-none")}>
            <span className={docBoxClass} aria-hidden="true" />
            {t("doc.todo1")}
          </p>
          <p className={cn(docLineClass, "animate-write [animation-delay:3.6s] motion-reduce:animate-none")}>
            <span className={docBoxClass} aria-hidden="true" />
            {t("doc.todo2")}
          </p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:4.6s] motion-reduce:animate-none")}>{t("doc.now")}</p>
          <p className={cn(docLineClass, docNowClass, "animate-write [animation-delay:5.0s] motion-reduce:animate-none")}>{t("doc.now1")}</p>
        </div>
      </div>

      <div className="mx-[clamp(0rem,4vw,2.5rem)] flex items-center gap-3 rounded-md bg-surface py-2 pr-2 pl-3 text-xs shadow-panel" aria-hidden="true">
        <span className="inline-flex items-center gap-2 font-mono font-medium text-red tabular-nums">LIVE 42:10</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">{t("doc.partial")}</span>
        <span className="grid size-8 place-items-center rounded-md border border-rail text-ink-2">
          <IconPause size={16} />
        </span>
        <span className="grid size-8 place-items-center rounded-md border border-rail text-ink-2">
          <IconStop size={14} />
        </span>
      </div>
      <figcaption className="text-center text-xs text-ink-3">{t("demoCaption")}</figcaption>
    </figure>
  );
}
