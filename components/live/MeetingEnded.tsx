"use client";

import { useLocale, useTranslations } from "next-intl";

import { useEffect, useRef } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { IconExternal, IconRefresh } from "@/components/ui/icons";
import { formatDuration } from "@/lib/format";
import { autoStopText } from "@/lib/ui/limit-copy";

/** After Stopp: the final pass is running (`finalizing`) or done. */
export function MeetingEnded({
  docUrl,
  durationSeconds,
  finalizing,
  orgHref,
  autoStopped,
  stopReason,
  shareFailed,
  pendingRuns,
  endFailed,
  onRetryEnd,
  signedOutUnsent,
  onReLogin,
  onEndWithoutUnsent,
  focusOnMount,
  privat,
  answersLost,
}: {
  docUrl: string | null;
  durationSeconds: number;
  finalizing?: boolean;
  orgHref: string;
  /** Ended by a limit rather than by a person. */
  autoStopped?: boolean;
  /** Which limit (heartbeat / token refusal reason), for the copy (C9). */
  stopReason?: string | null;
  /** Members the Doc could not be shared with at start (C10); null/undefined: unknown. */
  shareFailed?: number | null;
  /** Lines still waiting to reach the server after Avsluta (C6). */
  pendingRuns?: number;
  /** POST /end failed: offer a retry instead of leaving the page (C6). */
  endFailed?: boolean;
  onRetryEnd?: () => void;
  /** Signed out after Avsluta with lines unsent (R3): they need a new sign-in to be saved. */
  signedOutUnsent?: number | null;
  onReLogin?: () => void;
  onEndWithoutUnsent?: () => void;
  /** Move focus to the heading (after Avsluta, so screen readers hear the new state). */
  focusOnMount?: boolean;
  /** A Privat recording (0045): where its summary is shown, and the back link's words. */
  privat?: { summaryHref: string | null; backLabel: string } | null;
  /** The Avsluta dialog's answers came after the meeting had already ended: say so, never drop them silently. */
  answersLost?: boolean;
}) {
  const tt = useTranslations("tasks.end");
  const t = useTranslations("live.ended");
  const tp = useTranslations("privat.live");
  const locale = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  const waiting = (pendingRuns ?? 0) > 0;
  const shared =
    shareFailed && shareFailed > 0
      ? t("membersFailed", { count: shareFailed })
      : shareFailed === 0
        ? t("sharedWith")
        : "";
  return (
    <section className="flex flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby="ended-title" aria-live="polite">
      <h1 id="ended-title" className="text-2xl" ref={heading} tabIndex={-1}>
        {finalizing ? t("finalizing") : t("ended")}
      </h1>
      {answersLost && (
        <Banner tone="warning" title={tt("answersLostTitle")}>
          {tt("answersLostText")}
        </Banner>
      )}
      {waiting && (
        <Banner tone="warning" title={t("waitingTitle", { count: pendingRuns ?? 0 })}>
          {t("waitingText")}
        </Banner>
      )}
      {signedOutUnsent != null && (
        <Banner
          tone="danger"
          title={
            signedOutUnsent > 0 ? t("signedOutUnsent", { count: signedOutUnsent }) : t("signedOutEnd")
          }
          action={
            <span className="flex flex-wrap items-center gap-3">
              {onReLogin && (
                <Button variant="primary" onClick={onReLogin}>
                  {t("reLogin")}
                </Button>
              )}
              {onRetryEnd && (
                <Button icon={<IconRefresh size={18} />} onClick={onRetryEnd}>
                  {t("tryAgain")}
                </Button>
              )}
              {onEndWithoutUnsent && signedOutUnsent > 0 && (
                <Button variant="ghost" onClick={onEndWithoutUnsent}>
                  {t("endWithout")}
                </Button>
              )}
            </span>
          }
        >
          {t("signedOutText")}
        </Banner>
      )}
      {endFailed && (
        <Banner
          tone="danger"
          title={t("endFailedTitle")}
          action={
            onRetryEnd && (
              <Button variant="primary" icon={<IconRefresh size={18} />} onClick={onRetryEnd}>
                {t("tryAgain")}
              </Button>
            )
          }
        >
          {t("endFailedText")}
        </Banner>
      )}
      <p className="text-ink-2">
        {autoStopped && `${autoStopText(stopReason, locale)} `}
        {privat
          ? tp(finalizing ? "endedFinalizing" : "endedDone", { duration: formatDuration(durationSeconds, locale) })
          : finalizing
          ? `${t("finalizingText", { duration: formatDuration(durationSeconds, locale) })}${
              waiting || endFailed || signedOutUnsent != null ? "" : t("canClose")
            }`
          : shareFailed && shareFailed > 0
            ? t("doneShared", { duration: formatDuration(durationSeconds, locale), shared })
            : t("done", { duration: formatDuration(durationSeconds, locale), shared })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {docUrl && (
          <ButtonLink href={docUrl} target="_blank" rel="noopener noreferrer" variant="primary" size="lg" icon={<IconExternal size={18} />}>
            {t("openDoc")}
          </ButtonLink>
        )}
        {privat?.summaryHref && !finalizing && (
          <ButtonLink href={privat.summaryHref} variant={docUrl ? "secondary" : "primary"} size="lg">
            {tp("toSummary")}
          </ButtonLink>
        )}
        <ButtonLink href={orgHref} variant="ghost" size="lg">
          {privat ? privat.backLabel : t("backToOrg")}
        </ButtonLink>
      </div>
    </section>
  );
}
