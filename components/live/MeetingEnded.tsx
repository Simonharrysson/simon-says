"use client";

import { useEffect, useRef } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/Button";
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
  focusOnMount,
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
  /** Move focus to the heading (after Avsluta, so screen readers hear the new state). */
  focusOnMount?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  const waiting = (pendingRuns ?? 0) > 0;
  const shared =
    shareFailed && shareFailed > 0
      ? ` ${shareFailed === 1 ? "En medlem" : `${shareFailed} medlemmar`} fick inte åtkomst – dela dokumentet manuellt.`
      : shareFailed === 0
        ? " och delade med föreningens medlemmar"
        : "";
  return (
    <section className="ended" aria-labelledby="ended-title" aria-live="polite">
      <span className={`magnet ${finalizing ? "magnet--rail ended__magnet--busy" : "magnet--green"} ended__magnet`} aria-hidden="true" />
      <h1 id="ended-title" className="consent__title" ref={heading} tabIndex={-1}>
        {finalizing ? "Gör anteckningarna klara…" : "Mötet är avslutat"}
      </h1>
      {waiting && (
        <Banner tone="warning" title={`${pendingRuns} ${pendingRuns === 1 ? "rad väntar" : "rader väntar"} på nätet – stäng inte fliken`}>
          Det som sades sist har inte nått servern än. Vi försöker igen hela tiden; låt fliken vara öppen tills det här försvinner.
        </Banner>
      )}
      {endFailed && (
        <Banner
          tone="danger"
          title="Mötet kunde inte avslutas"
          action={
            onRetryEnd && (
              <Button variant="primary" icon={<IconRefresh size={18} />} onClick={onRetryEnd}>
                Försök igen
              </Button>
            )
          }
        >
          Vi nådde inte servern. Kontrollera nätet och försök igen. Stänger du fliken avslutas mötet ändå inom en kvart.
        </Banner>
      )}
      <p className="muted">
        {autoStopped && `${autoStopText(stopReason)} `}
        {finalizing
          ? `Ni pratade i ${formatDuration(durationSeconds)}. Anteckningarna får en sista genomgång, det tar ungefär en minut.${
              waiting || endFailed ? "" : " Du kan stänga fliken, det blir klart ändå."
            }`
          : shareFailed && shareFailed > 0
            ? `Ni pratade i ${formatDuration(durationSeconds)}. Anteckningarna är färdiga.${shared}`
            : `Ni pratade i ${formatDuration(durationSeconds)}. Anteckningarna är färdiga${shared}.`}
      </p>
      <div className="cluster">
        {docUrl && (
          <ButtonLink href={docUrl} target="_blank" rel="noopener noreferrer" variant="primary" size="lg" icon={<IconExternal size={18} />}>
            Öppna dokumentet
          </ButtonLink>
        )}
        <ButtonLink href={orgHref} variant="ghost" size="lg">
          Tillbaka till föreningen
        </ButtonLink>
      </div>
    </section>
  );
}
