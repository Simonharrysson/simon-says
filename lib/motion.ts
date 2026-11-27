// The app's motion values in one place (docs/ui.md "Motion"). The CSS side has the same springs
// as `linear()` easings (app/globals.css: --ease-spring, --ease-press), sampled from these.

/** Lists: rows that expand in, collapse out, or move (height and opacity, then FLIP). */
export const SPRING = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;
/** Leaving is quicker than arriving. */
export const SPRING_EXIT = { type: "spring", visualDuration: 0.22, bounce: 0 } as const;

/**
 * Entrances (WAAPI): content that replaces its placeholder rises 14 px and comes into focus from a
 * 4 px blur, 40 ms apart, never more than 280 ms of total delay, on EASE_ENTER.
 */
export const ENTER = { rise: 14, blur: 4, stagger: 40, maxDelay: 280, duration: 460 } as const;
/** motion `spring({ visualDuration: 0.35, bounce: 0.1 })`, settles in 460 ms. */
export const EASE_ENTER =
  "linear(0, 0.0203, 0.0716, 0.1418, 0.2223, 0.3067, 0.3904, 0.4706, 0.5453, 0.6133, 0.6743, 0.7282, 0.7751, 0.8156, 0.8501, 0.8793, 0.9037, 0.924, 0.9406, 0.9542, 0.9652, 0.974, 0.9809, 0.9864, 0.9906, 0.9938, 0.9962, 0.998, 0.9993, 1.0002, 1.0008, 1.0012, 1)";
/** The same spring as `--ease-spring` (motion `spring({ visualDuration: 0.3, bounce: 0.15 })`, settles in 550 ms). */
export const EASE_SPRING =
  "linear(0, 0.038, 0.1281, 0.2432, 0.3653, 0.483, 0.5898, 0.6827, 0.7607, 0.8243, 0.8747, 0.9138, 0.9433, 0.965, 0.9804, 0.9911, 0.9981, 1.0025, 1.0049, 1.006, 1.0063, 1.006, 1.0054, 1.0047, 1.0039, 1.0032, 1.0025, 1.0019, 1.0015, 1.0011, 1.0008, 1.0005, 1)";

/** Count-ups: from 0 to the value on the app's ease-out. */
export const COUNT_MS = 600;

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `cubic-bezier(x1, y1, x2, y2)` as a function of progress (the --ease-out token for count-ups). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bez(x1, x2, t) - x) / d;
    }
    // Newton can leave [0, 1] on steep curves: bisect from there.
    if (t < 0 || t > 1 || Math.abs(bez(x1, x2, t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (bez(x1, x2, t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return bez(y1, y2, t);
  };
}

/** --ease-out: cubic-bezier(0.16, 1, 0.3, 1). */
export const easeOut = cubicBezier(0.16, 1, 0.3, 1);
