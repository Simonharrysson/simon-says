import { Button } from "@/components/ui/Button";
import { IconPlay } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";

/** Shown when the page finds an unfinished meeting (live, or abandoned < 2 h ago). */
export function ResumeMeeting({
  startedAt,
  orgName,
  onResume,
  onEnd,
  resuming,
}: {
  startedAt: string;
  orgName: string;
  onResume: () => void;
  onEnd?: () => void;
  resuming?: boolean;
}) {
  return (
    <section className="resume" aria-labelledby="resume-title">
      <span className="magnet resume__magnet" aria-hidden="true" />
      <div className="stack" style={{ ["--stack-gap" as string]: "0.5rem" }}>
        <h1 id="resume-title" className="consent__title">
          Mötet är inte avslutat
        </h1>
        <p className="muted">
          Mötet i {orgName} startade kl. {formatClock(startedAt)} men avslutades aldrig. Kanske stängdes fliken eller somnade
          datorn. Allt som hann transkriberas finns kvar.
        </p>
      </div>
      <div className="cluster">
        <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={resuming}>
          Fortsätt mötet
        </Button>
        {onEnd && (
          <Button variant="ghost" size="lg" onClick={onEnd} disabled={resuming}>
            Avsluta det i stället
          </Button>
        )}
      </div>
    </section>
  );
}
