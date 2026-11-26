import { IconMic, IconMicOff, IconPause } from "@/components/ui/icons";
import { tailText } from "@/lib/format";
import type { PartialMode } from "@/lib/ui/live-status";
import { cn } from "@/lib/utils";

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
    <section
      className="grid grid-cols-[auto_1fr] items-center gap-4 rounded-lg bg-board px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]"
      data-mode={mode}
      aria-label="Det mikrofonen hör just nu"
    >
      <span
        className={cn(
          "relative grid size-11 place-items-center rounded-full bg-surface shadow-panel",
          mode === "live" ? "text-red" : "text-ink-3",
        )}
        aria-hidden="true"
      >
        {icon}
        {mode === "live" && (
          // The listening ring follows the mic level (--level 0–1): still when the mic hears
          // nothing, so a dead mic is visible. Reduced motion: opacity only, no scaling.
          <span
            className="absolute -inset-1 [scale:calc(1+0.3*var(--level))] rounded-[inherit] border-2 border-[color-mix(in_srgb,var(--red)_45%,transparent)] opacity-[calc(0.15+0.85*var(--level))] transition-[scale,opacity] duration-160 ease-out motion-reduce:[scale:none] motion-reduce:transition-opacity motion-reduce:duration-400 motion-reduce:ease-linear"
            style={{ ["--level" as string]: ring.toFixed(2) }}
          />
        )}
      </span>
      <div className="flex min-w-0 flex-col">
        {!fixed && speaker && <span className="text-xs font-semibold text-blue">{speaker}</span>}
        {/* At most two lines, anchored to the end: overflow cuts the oldest words, never the newest. */}
        <p className={cn("flex max-h-[calc(2*1.45em)] flex-col justify-end overflow-hidden text-base leading-[1.45]", mode === "last-heard" ? "text-ink-3" : "text-ink-2")}>
          {fixed ? (
            <span className="text-ink-3">{fixed}</span>
          ) : (
            <span>
              {tailText(text, 120)}
              {mode === "last-heard" && <span className="italic"> (senaste vi hörde)</span>}
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
