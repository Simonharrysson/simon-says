import { formatElapsed } from "@/lib/format";

/**
 * The meeting clock. Pass elapsed time (the caller ticks it); `limitMs` shows the remaining
 * allowance as a thin rail under the digits. Announced to screen readers only on request
 * (role="timer" is polite by default and not read every second).
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
    <div className={`timer timer--${size}${paused ? " timer--paused" : ""}${warn ? " timer--warn" : ""}`}>
      <span className="timer__digits" role="timer" aria-label={`Mötestid ${formatElapsed(elapsedMs)}`}>
        {formatElapsed(elapsedMs)}
      </span>
      <span className="timer__rail" aria-hidden="true">
        <span className="timer__fill" style={{ transform: `scaleX(${share})` }} />
      </span>
    </div>
  );
}
