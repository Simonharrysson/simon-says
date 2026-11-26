import { formatElapsed } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The meeting clock. Pass elapsed time (the caller ticks it); `limitMs` shows the remaining
 * allowance as a thin rail under the digits (`--rail` track, ink fill, red in the last 15 min).
 * Announced to screen readers only on request (role="timer" is polite by default and not read
 * every second).
 */
export function MeetingTimer({
  elapsedMs,
  paused,
  limitMs = 4 * 60 * 60 * 1000,
  size = "lg",
}: {
  elapsedMs: number;
  paused?: boolean;
  limitMs?: number;
  size?: "md" | "lg";
}) {
  const share = Math.min(1, Math.max(0, elapsedMs / limitMs));
  const warn = limitMs - elapsedMs <= 15 * 60 * 1000;
  return (
    <div className="inline-grid gap-2 justify-self-end">
      <span
        className={cn(
          "font-mono leading-none font-medium tracking-[-0.03em] tabular-nums",
          size === "lg" ? "text-[clamp(1.75rem,1.2rem+2vw,2.5rem)]" : "text-xl",
          paused && "text-ink-3",
        )}
        role="timer"
        aria-label={`Mötestid ${formatElapsed(elapsedMs)}`}
      >
        {formatElapsed(elapsedMs)}
      </span>
      <span className="h-1 w-full overflow-hidden rounded-[4px] bg-rail" aria-hidden="true">
        <span
          className={cn("block h-full origin-left rounded-[inherit] transition-transform duration-1000 ease-linear", warn ? "bg-red" : "bg-ink")}
          style={{ transform: `scaleX(${share})` }}
        />
      </span>
    </div>
  );
}
