"use client";

import { useLayoutEffect, useRef } from "react";
import { COUNT_MS, easeOut, reducedMotion } from "@/lib/motion";
import { useMountedFresh } from "./fresh";

/**
 * A count text ("2 beslut · 5 uppgifter", "4 personer · 12 möten") whose numbers count up from 0
 * once, when it mounts in a client render. The server HTML and every later render hold the final
 * text (screen readers and a page load see only that). Each number sits in a box as wide as its
 * final digits (tabular figures), so the words beside it never move.
 */
export function CountUp({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const fresh = useMountedFresh();
  // Once: an <Activity> that shows a kept tab again re-runs layout effects, but not this.
  const counted = useRef(false);
  const parts = text.split(/(\d+)/);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!fresh || !root || counted.current || reducedMotion()) return;
    counted.current = true;
    const nums = [...root.querySelectorAll<HTMLElement>("[data-count]")].map((el) => ({ el, to: Number(el.dataset.count) }));
    if (!nums.some((n) => n.to > 0)) return;
    const set = (p: number) => {
      for (const n of nums) n.el.textContent = String(Math.round(n.to * easeOut(p)));
    };
    set(0);
    const start = performance.now();
    let finished = false;
    let frame = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - start) / COUNT_MS);
      set(p);
      if (p < 1) frame = requestAnimationFrame(step);
      else finished = true;
    });
    return () => {
      cancelAnimationFrame(frame);
      set(1);
      // Cut short (hidden at once, or React's dev double effect): it may count again.
      if (!finished) counted.current = false;
    };
    // Once, at mount: later text changes render as they are.
  }, [fresh]);

  return (
    <span ref={ref} className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} data-count={part} className="inline-block text-right tabular-nums" style={{ minWidth: `${part.length}ch` }}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}
