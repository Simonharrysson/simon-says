import { Button } from "@/components/ui/Button";
import { IconCheck } from "@/components/ui/icons";

export interface NameRoundEntry {
  key: string;
  /** "Talare 2" */
  label: string;
  /** Name heard so far, or null while we wait. */
  name: string | null;
  needsConfirm: boolean;
}

/**
 * Right after Start: everyone says "Jag heter …" in turn. Names pop in as they're heard;
 * "Klar" ends the round (or "Hoppa över" for a meeting where everyone is already known).
 */
export function NameRound({
  entries,
  onDone,
  onSkip,
}: {
  entries: NameRoundEntry[];
  onDone: () => void;
  onSkip?: () => void;
}) {
  const heard = entries.filter((e) => e.name);
  return (
    <section className="nameround" aria-labelledby="nameround-title">
      <div className="nameround__prompt">
        <h2 id="nameround-title" className="nameround__title">
          Namnrunda
        </h2>
        <p className="nameround__say">
          Säg <q>Jag heter …</q> en i taget.
        </p>
        <p className="muted">Då står det era namn i anteckningarna i stället för Talare 1, Talare 2.</p>
      </div>
      <ol className="nameround__list" aria-live="polite" aria-label="Namn vi hört">
        {heard.length === 0 && <li className="nameround__waiting">Väntar på första namnet…</li>}
        {heard.map((entry) => (
          <li key={entry.key} className={`nameplate${entry.needsConfirm ? " nameplate--unsure" : ""}`}>
            <span className="magnet magnet--blue" aria-hidden="true" />
            <span className="nameplate__name">
              {entry.name}
              {entry.needsConfirm && "?"}
            </span>
            <span className="nameplate__label">{entry.label}</span>
          </li>
        ))}
      </ol>
      <div className="cluster">
        <Button variant="primary" icon={<IconCheck />} onClick={onDone} disabled={heard.length === 0}>
          Klar, alla har sagt sitt namn
        </Button>
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            Hoppa över
          </Button>
        )}
      </div>
    </section>
  );
}
