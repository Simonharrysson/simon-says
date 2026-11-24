import { IconMic, IconPause } from "@/components/ui/icons";
import { tailText } from "@/lib/format";

/**
 * What the microphone hears right now (ElevenLabs partials; display only, never stored).
 * Newest words stay visible at the end; older text fades out to the left.
 */
export function PartialStrip({
  text,
  speaker,
  paused,
  listening = true,
}: {
  text: string;
  speaker?: string | null;
  paused?: boolean;
  listening?: boolean;
}) {
  return (
    <section className={`partial${paused ? " partial--paused" : ""}`} aria-label="Det mikrofonen hör just nu">
      <span className="partial__icon" aria-hidden="true">
        {paused ? <IconPause size={18} /> : <IconMic size={18} />}
        {!paused && listening && <span className="partial__level" />}
      </span>
      <p className="partial__text">
        {paused ? (
          <span className="partial__placeholder">Pausat. Inget ljud skickas.</span>
        ) : text ? (
          <>
            {speaker && <span className="partial__speaker">{speaker}: </span>}
            <span>{tailText(text)}</span>
          </>
        ) : (
          <span className="partial__placeholder">Lyssnar…</span>
        )}
      </p>
    </section>
  );
}
