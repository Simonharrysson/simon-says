import { useTranslations } from "next-intl";
import { ButtonLink, buttonVariants } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconGoogle, IconPause, IconStop } from "@/components/ui/icons";
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

export function LandingView({ user, signIn }: LandingViewProps) {
  const t = useTranslations("landing");
  const common = useTranslations("login");
  return (
    <>
      <section className="pt-[clamp(2rem,6vw,5rem)] pb-[clamp(2rem,4vw,3rem)]" aria-labelledby="hero-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-[clamp(2rem,5vw,4.5rem)] px-gutter max-[60rem]:grid-cols-[minmax(0,1fr)]">
          <div className="flex flex-col gap-6">
            <h1 id="hero-title" className="text-display leading-[1.05] font-semibold tracking-[-0.045em] [overflow-wrap:break-word] hyphens-manual">
              {t("heroTitle")}
            </h1>
            <p className="max-w-[38rem] text-lg text-ink-2">{t("heroText")}</p>
            <div className="flex flex-wrap gap-2 max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full max-[30rem]:[&>*]:w-full">
              {user ? (
                <ButtonLink href="/orgs" variant="primary" size="lg" icon={<IconArrowRight />}>
                  {t("toOrgs")}
                </ButtonLink>
              ) : (
                <form action={signIn}>
                  <input type="hidden" name="next" value="/hem" />
                  <SubmitButton variant="primary" size="lg" icon={<IconGoogle />} pendingLabel={common("sendingToGoogle")}>
                    {t("signIn")}
                  </SubmitButton>
                </form>
              )}
              <a className={buttonVariants({ variant: "ghost", size: "lg" })} href="#sa-funkar-det">
                {t("howItGoes")}
              </a>
            </div>
            <p className="text-sm text-ink-3">
              {user ? (
                t("signedInAs", { email: user.email })
              ) : (
                t("freeLine")
              )}
            </p>
          </div>

          <BoardDemo />
        </div>
      </section>

      <section id="sa-funkar-det" className="py-[clamp(3rem,7vw,6rem)]" aria-labelledby="steps-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="steps-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
            {t("howItGoes")}
          </h2>
          <ol className="mt-12 grid grid-cols-3 gap-8 max-md:grid-cols-1 max-md:gap-6">
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">{t("step1Title")}</h3>
              <p className="text-ink-2">{t("step1Text")}</p>
            </li>
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">{t("step2Title")}</h3>
              <p className="text-ink-2">{t("step2Text")}</p>
            </li>
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">{t("step3Title")}</h3>
              <p className="text-ink-2">{t("step3Text")}</p>
            </li>
          </ol>
        </div>
      </section>

      <section className="bg-sunk py-[clamp(3rem,7vw,6rem)]" aria-labelledby="edits-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-2 items-center gap-[clamp(2rem,5vw,4rem)] px-gutter max-[52rem]:grid-cols-1">
          <div className="flex flex-col gap-4">
            <h2 id="edits-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
              {t("editsTitle")}
            </h2>
            <p className="text-ink-2 max-w-[68ch]">{t("editsText")}</p>
          </div>
          <div className="flex flex-col gap-2 rounded-[4px] bg-white p-6 font-system text-sm text-[#202124] shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_4px_12px_-6px_rgb(0_0_0/0.12)]" aria-hidden="true">
            <p className="border-b border-[#e0e0e0] pb-1 text-2xs font-bold tracking-[0.06em] text-[#5f6368] uppercase">{t("doc.todo")}</p>
            <p className="flex flex-wrap items-baseline gap-[0.55em]">
              <span className={docBoxClass} /> {t("doc.editTodo1")}
            </p>
            <p className="flex flex-wrap items-baseline gap-[0.55em] rounded-[3px] bg-[#e8f0fe] px-2 py-[0.2rem] [&_ins]:text-[#1a56c4] [&_ins]:no-underline">
              <span className={docBoxClass} /> {t("doc.editTodo2")} <ins>{t("doc.editInsert")}</ins>
              <span className="inline-block h-[1.1em] w-[2px] translate-y-[0.18em] animate-caret bg-[#1a56c4]" />
            </p>
            <p className="inline-flex items-center gap-2 text-2xs font-semibold text-[#1a56c4]">
              {t("doc.editLocked")}
            </p>
          </div>
        </div>
      </section>

      <section className="py-[clamp(3rem,7vw,6rem)]" aria-labelledby="facts-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="facts-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
            {t("factsTitle")}
          </h2>
          <dl className="mt-12 grid grid-cols-4 gap-8 max-[56rem]:grid-cols-2 max-[34rem]:grid-cols-1 max-[34rem]:gap-6 [&>div]:border-t [&>div]:border-rail [&>div]:pt-3 [&_dd]:mt-2 [&_dd]:text-ink-2 [&_dt]:text-lg [&_dt]:font-semibold [&_dt]:tracking-[-0.01em]">
            <div>
              <dt>{t("fact1Title")}</dt>
              <dd>{t("fact1Text")}</dd>
            </div>
            <div>
              <dt>{t("fact2Title")}</dt>
              <dd>{t("fact2Text")}</dd>
            </div>
            <div>
              <dt>{t("fact3Title")}</dt>
              <dd>{t("fact3Text")}</dd>
            </div>
            <div>
              <dt>{t("fact4Title")}</dt>
              <dd>{t("fact4Text")}</dd>
            </div>
          </dl>
          <p className="mt-8 max-w-[48rem] text-ink-2">
            {t.rich("limits", {
              repo: (chunks) => <a href={REPO}>{chunks}</a>,
              status: (chunks) => <a href="/status">{chunks}</a>,
            })}
          </p>
          <p className="mt-3 max-w-[48rem] text-ink-2">{t("privatLine")}</p>
        </div>
      </section>

      <section className="border-t border-line py-[clamp(3rem,7vw,6rem)]" aria-labelledby="close-title">
        <div className="mx-auto flex w-full max-w-page flex-col items-start gap-4 px-gutter">
          <h2 id="close-title" className="text-[clamp(2rem,1.4rem+2.4vw,3.25rem)] tracking-[-0.04em]">
            {t("closeTitle")}
          </h2>
          <p className="text-ink-2">{t("closeText")}</p>
          {user ? (
            <ButtonLink href="/orgs" variant="primary" size="lg" icon={<IconArrowRight />}>
              {t("toOrgs")}
            </ButtonLink>
          ) : (
            <form action={signIn}>
              <input type="hidden" name="next" value="/hem" />
              <SubmitButton variant="primary" size="lg" icon={<IconGoogle />} pendingLabel={common("sendingToGoogle")}>
                {t("signIn")}
              </SubmitButton>
            </form>
          )}
        </div>
      </section>
    </>
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
          <p className={docLiveClass}>
            {t("doc.live")}
          </p>
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
        <span className="inline-flex items-center gap-2 font-mono font-medium text-red tabular-nums">
          LIVE 42:10
        </span>
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
