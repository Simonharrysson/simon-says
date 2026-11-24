import { IconMic, IconMicOff, IconPause } from "@/components/ui/icons";
import { tailText } from "@/lib/format";
import type { PartialMode } from "@/lib/ui/live-status";

/**
 * Proof that the microphone hears the room (ElevenLabs partials; display only, never stored).
 * Deliberately quiet: body size, grey, at most two lines. The box is anchored to its end, so
 * when text overflows it is the oldest words that disappear, never the newest.
 */
export function PartialStrip({ text, speaker, mode = "live" }: { text: string; speaker?: string | null; mode?: PartialMode }) {
  const icon =
    mode === "paused" ? <IconPause size={18} /> : mode === "silent" ? <IconMicOff size={18} /> : <IconMic size={18} />;
  const fixed =
    mode === "paused" ? "Pausat. Inget ljud skickas." : mode === "silent" ? "Inget ljud skickas just nu." : !text ? "Lyssnar…" : null;
  return (
    <section className={`partial partial--${mode}`} aria-label="Det mikrofonen hör just nu">
      <span className="partial__icon" aria-hidden="true">
        {icon}
        {mode === "live" && <span className="partial__level" />}
      </span>
      <div className="partial__body">
        {!fixed && speaker && <span className="partial__speaker">{speaker}</span>}
        <p className="partial__text">
          {fixed ? (
            <span className="partial__placeholder">{fixed}</span>
          ) : (
            <span>
              {tailText(text, 120)}
              {mode === "last-heard" && <span className="partial__note"> (senaste vi hörde)</span>}
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
