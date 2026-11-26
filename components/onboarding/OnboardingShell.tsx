"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { IconArrowLeft, IconArrowRight } from "@/components/ui/icons";
import { STEPS, type StepId } from "@/lib/onboarding/steps";
import { cn } from "@/lib/utils";
import { OrgLogo } from "./OrgLogo";

// Kom igång (todo #5): the calm frame around one step at a time. A thin six-part progress rail
// (done = ink, skipped = grey, here = blue; never dots), the step's title, its content sliding in
// (from the right going forward, from the left going back; off with reduced motion) and one footer:
// Tillbaka · Hoppa över · the step's primary action.

export type ShellStep = StepId | "klart";

export interface OnboardingShellProps {
  orgName: string;
  orgHref: string;
  logoUrl?: string | null;
  step: ShellStep;
  done: StepId[];
  skipped: StepId[];
  /** Jump to a step from the progress rail. */
  onGo?: (step: StepId) => void;
  /** Which way the last move went: the slide's direction. */
  direction?: "forward" | "back";
  /** The step's title and one-line lead. */
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function OnboardingShell(p: OnboardingShellProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // A new step moves focus to its heading (the pressed button is gone); not on first load.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [p.step]);
  const index = p.step === "klart" ? STEPS.length : STEPS.findIndex((s) => s.id === p.step);

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-gutter">
      <header className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <a className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-3 no-underline hover:text-ink md:min-h-0" href={p.orgHref}>
            <OrgLogo name={p.orgName} src={p.logoUrl} size="sm" className="size-6 rounded-[5px] text-2xs" />
            <span className="wrap-anywhere">{p.orgName}</span>
          </a>
          <a className="text-sm text-ink-3 no-underline hover:text-ink" href={p.orgHref}>
            Fortsätt senare
          </a>
        </div>
        <Progress step={p.step} done={p.done} skipped={p.skipped} onGo={p.onGo} />
      </header>

      <div key={p.step} className={cn("flex flex-col gap-8", p.direction === "back" ? "animate-step-back" : "animate-step-in")}>
        <div className="flex flex-col gap-2">
          {p.step !== "klart" && (
            <p className="text-sm text-ink-3" aria-hidden="true">
              {`Steg ${index + 1} av ${STEPS.length}`}
            </p>
          )}
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl focus:outline-none">
            {p.title}
          </h1>
          {p.lead && <div className="max-w-[34rem] text-ink-2">{p.lead}</div>}
        </div>
        {p.children}
      </div>
      {p.footer}
    </div>
  );
}

function Progress({ step, done, skipped, onGo }: { step: ShellStep; done: StepId[]; skipped: StepId[]; onGo?: (s: StepId) => void }) {
  return (
    <ol className="grid grid-cols-6 gap-1.5" aria-label="Kom igång">
      {STEPS.map((s, i) => {
        const here = s.id === step;
        const isDone = done.includes(s.id);
        const isSkipped = !isDone && skipped.includes(s.id);
        const state = here ? "nu" : isDone ? "klart" : isSkipped ? "hoppades över" : "inte gjort än";
        const bar = (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "block h-1 w-full rounded-full transition-colors duration-200 ease-out",
                here ? "bg-blue" : isDone ? "bg-ink" : isSkipped ? "bg-rail" : "bg-line",
              )}
            />
            <span className={cn("mt-2 block truncate text-left text-2xs max-[30rem]:sr-only", here ? "font-medium text-ink" : "text-ink-3")}>
              {s.short}
            </span>
            <span className="sr-only">
              {`Steg ${i + 1}, ${s.title}: ${state}`}
            </span>
          </>
        );
        return (
          <li key={s.id} aria-current={here ? "step" : undefined}>
            {onGo ? (
              <button type="button" onClick={() => onGo(s.id)} className="block w-full cursor-pointer rounded-sm py-1 hover:[&>span:first-child]:opacity-70">
                {bar}
              </button>
            ) : (
              <div className="py-1">{bar}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The step's footer: back on the left; skip and the primary action on the right. */
export function StepFooter({
  onBack,
  onSkip,
  onNext,
  nextLabel = "Fortsätt",
  skipLabel = "Hoppa över",
  busy,
  nextDisabled,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  skipLabel?: string;
  busy?: boolean;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 max-[30rem]:flex-col-reverse max-[30rem]:items-stretch">
      <div>
        {onBack && (
          <Button variant="ghost" icon={<IconArrowLeft size={18} />} onClick={onBack} disabled={busy} className="max-[30rem]:w-full">
            Tillbaka
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-[30rem]:flex-col-reverse max-[30rem]:items-stretch">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} disabled={busy}>
            {skipLabel}
          </Button>
        )}
        {onNext && (
          <Button variant="primary" onClick={onNext} loading={busy} disabled={nextDisabled}>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              {nextLabel}
              <IconArrowRight size={18} />
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}
