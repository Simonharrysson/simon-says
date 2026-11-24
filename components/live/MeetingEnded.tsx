import { ButtonLink } from "@/components/ui/Button";
import { IconExternal } from "@/components/ui/icons";
import { formatDuration } from "@/lib/format";

/** After Stopp: the final pass is running (`finalizing`) or done. */
export function MeetingEnded({
  docUrl,
  durationSeconds,
  finalizing,
  orgHref,
  autoStopped,
}: {
  docUrl: string | null;
  durationSeconds: number;
  finalizing?: boolean;
  orgHref: string;
  /** Ended by the 4 h limit rather than by a person. */
  autoStopped?: boolean;
}) {
  return (
    <section className="ended" aria-labelledby="ended-title" aria-live="polite">
      <span className={`magnet ${finalizing ? "magnet--rail ended__magnet--busy" : "magnet--green"} ended__magnet`} aria-hidden="true" />
      <h1 id="ended-title" className="consent__title">
        {finalizing ? "Gör anteckningarna klara…" : "Mötet är avslutat"}
      </h1>
      <p className="muted">
        {autoStopped && "Mötet nådde gränsen på 4 timmar och avslutades automatiskt. "}
        {finalizing
          ? `Ni pratade i ${formatDuration(durationSeconds)}. Anteckningarna får en sista genomgång, det tar ungefär en minut. Du kan stänga fliken, det blir klart ändå.`
          : `Ni pratade i ${formatDuration(durationSeconds)}. Anteckningarna är färdiga och delade med föreningens medlemmar.`}
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
