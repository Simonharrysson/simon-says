import { IconMic, IconMicOff, IconPause } from "@/components/ui/icons";
import { tailText } from "@/lib/format";
import type { PartialMode } from "@/lib/ui/live-status";

/**
 * Proof that the microphone hears the room (ElevenLabs partials; display only, never stored).
 * Deliberately quiet: body size, grey, at most two lines. The box is anchored to its end, so
 * when text overflows it is the oldest words that disappear, never the newest.
 */
export function PartialStrip({
  text,
  speaker,
  mode = "live",
  level,
}: {
  text: string;
  speaker?: string | null;
  mode?: PartialMode;
  /** Mic level 0–1: drives the ring, so a dead mic shows a still ring (C4). */
  level?: number | null;
}) {
  // rms of speech is roughly 0.05–0.3: stretch it so normal talk fills the ring.
  const ring = Math.max(0, Math.min(1, (level ?? 0) * 4));
  const icon =
    mode === "paused" ? <IconPause size={18} /> : mode === "silent" ? <IconMicOff size={18} /> : <IconMic size={18} />;
  const fixed =
    mode === "paused" ? "Pausat. Inget ljud skickas." : mode === "silent" ? "Inget ljud skickas just nu." : !text ? "Lyssnar…" : null;
  return (
    <section className={`partial partial--${mode}`} aria-label="Det mikrofonen hör just nu">
      <span className="partial__icon" aria-hidden="true">
        {icon}
        {mode === "live" && <span className="partial__level" style={{ ["--level" as string]: ring.toFixed(2) }} />}
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
