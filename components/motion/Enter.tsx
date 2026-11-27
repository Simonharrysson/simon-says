"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { EASE_ENTER, ENTER, reducedMotion } from "@/lib/motion";
import { useMountedFresh } from "./fresh";

/** What rises in, top-level only: panels (cards), banners, and anything marked `data-enter-item`. */
const ITEM = '[data-slot="card"], [data-slot="alert"], [data-enter-item]';

/** The entrance's items: the outermost ITEM matches under `root` (a card's own rows ride with it). */
export function enterItems(root: HTMLElement): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(ITEM)].filter((el) => {
    const outer = el.parentElement?.closest(ITEM);
    return !(outer && root.contains(outer));
  });
  return found.filter((el) => el.checkVisibility?.() ?? el.offsetParent !== null);
}

/**
 * Staggered entrance (WAAPI; transform, opacity and a small blur, so no layout shift). Each item
 * rises 14 px, fades in and comes into focus on a spring, 40 ms after the one before. `fill: backwards` holds the start
 * frame through the delay and nothing after the end, so content is never left hidden and clicks
 * work throughout. Returns a cancel.
 */
export function enter(root: HTMLElement): () => void {
  const anims = enterItems(root).map((el, i) =>
    el.animate(
      [
        { opacity: 0, transform: `translateY(${ENTER.rise}px)`, filter: `blur(${ENTER.blur}px)` },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
      ],
      { duration: ENTER.duration, easing: EASE_ENTER, delay: Math.min(i * ENTER.stagger, ENTER.maxDelay), fill: "backwards", id: "enter" },
    ),
  );
  return () => anims.forEach((a) => a.cancel());
}

/**
 * Runs `enter` on a region when it mounts in a client render (navigation, back/forward, content
 * streaming in after one), before the first paint. Never on a page load (hydration): the first
 * paint is the final one. `replay`: also when an <Activity> shows the region again.
 */
export function useEntrance<T extends HTMLElement>(replay = false) {
  const ref = useRef<T>(null);
  const fresh = useMountedFresh();
  const again = useRef(replay);
  again.current = replay;
  useLayoutEffect(() => {
    if (!ref.current || !(fresh || again.current) || reducedMotion()) return;
    return enter(ref.current);
    // Mount (and an <Activity> reveal) only: `fresh` is frozen, `replay` is read when it runs.
  }, [fresh]);
  return ref;
}

/** A region whose panels rise in on a client navigation. `display: contents` by default, so it adds no box. */
export function Enter({ children, className = "contents", replay }: { children: ReactNode; className?: string; replay?: boolean }) {
  const ref = useEntrance<HTMLDivElement>(replay);
  return (
    <div ref={ref} className={className} data-enter="">
      {children}
    </div>
  );
}
