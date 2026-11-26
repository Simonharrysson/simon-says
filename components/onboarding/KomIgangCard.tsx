"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ButtonLink, Button } from "@/components/ui/button";
import { IconArrowRight } from "@/components/ui/icons";
import { handled, resumeStep, STEPS, stepNumber, type OnboardingState } from "@/lib/onboarding/steps";
import { cn } from "@/lib/utils";

// The förening page's "Kom igång n/6" card (admins, until every step is handled or it is hidden).

export function KomIgangCard({ orgId, state, onDismiss }: { orgId: string; state: OnboardingState; onDismiss?: () => Promise<unknown> }) {
  const t = useTranslations("onboarding");
  const [hiding, setHiding] = useState(false);
  const n = handled(state).length;
  const next = resumeStep(state);
  const nextTitle = next ? t(`steps.${next}.title`) : null;
  const href = `/orgs/${orgId}/kom-igang${next ? `?steg=${stepNumber(next)}` : "?steg=klart"}`;
  return (
    <section aria-labelledby="kom-igang-title" className="flex flex-col gap-4 rounded-lg bg-surface p-6 shadow-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="kom-igang-title" className="text-lg">
          {t("card.title")} <span className="font-normal text-ink-3">{n}/{STEPS.length}</span>
        </h2>
        {nextTitle && <p className="text-sm text-ink-3">{t("card.next", { title: nextTitle })}</p>}
      </div>
      <div className="grid grid-cols-6 gap-1.5" role="progressbar" aria-label={t("card.title")} aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={n} aria-valuetext={t("card.progress", { n, total: STEPS.length })}>
        {STEPS.map((s) => (
          <span key={s.id} className={cn("h-1 rounded-full", state.done.includes(s.id) ? "bg-ink" : state.skipped.includes(s.id) ? "bg-rail" : "bg-line")} />
        ))}
      </div>
      <p className="max-w-[60ch] text-sm text-ink-2">
        {t("card.text")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={href} variant="primary" size="sm" icon={<IconArrowRight size={16} />}>
          {n === 0 ? t("card.start") : t("card.continue")}
        </ButtonLink>
        {onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            loading={hiding}
            onClick={async () => {
              setHiding(true);
              await onDismiss().catch(() => null);
              setHiding(false);
            }}
          >
            {t("card.hide")}
          </Button>
        )}
      </div>
    </section>
  );
}
