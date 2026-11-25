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
 * Right after Start: everyone says "Jag heter …" in turn. Voices show up as they're heard
 * ("Talare 2 …"); the names are read from what was said when "Klar" is pressed (or by the
 * server after about two minutes). "Hoppa över" for a meeting where everyone is already known.
 * While it runs, this is the only list of names on the page (the speaker list waits).
 */
export function NameRound({
  entries,
  onDone,
  onSkip,
  busy,
}: {
  entries: NameRoundEntry[];
  onDone: () => void;
  onSkip?: () => void;
  /** "Klar" was pressed: the names are being read. */
  busy?: boolean;
}) {
  const heard = entries;
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
        {heard.length === 0 && <li className="nameround__waiting">Väntar på första rösten…</li>}
        {heard.map((entry) => (
          <li key={entry.key} className={`nameplate${entry.needsConfirm ? " nameplate--unsure" : ""}`}>
            <span className="magnet magnet--blue" aria-hidden="true" />
            <span className="nameplate__name">
              {entry.name ?? "…"}
              {entry.name && entry.needsConfirm && "?"}
            </span>
            <span className="nameplate__label">{entry.label}</span>
          </li>
        ))}
      </ol>
      {heard.some((e) => e.name && e.needsConfirm) && (
        <p className="subtle">Namn med frågetecken kan du rätta i talarlistan när rundan är klar.</p>
      )}
      <div className="cluster">
        <Button variant="primary" icon={<IconCheck />} onClick={onDone} disabled={busy}>
          {busy ? "Läser namnen…" : "Klar, alla har sagt sitt namn"}
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
