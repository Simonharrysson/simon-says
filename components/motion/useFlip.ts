"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { EASE_SPRING, reducedMotion } from "@/lib/motion";

/**
 * FLIP for a list whose rows change order (an agenda point moved up, a ticked task moving to the
 * done ones): rows marked `data-flip="<key>"` that moved slide from where they were. `keys` are
 * the rows in order; only when they change are positions read, during render, i.e. just before
 * React changes the DOM (so typing in a row costs nothing, and a sibling's earlier height
 * animation can't fake a move). Transform only.
 */
export function useFlip<T extends HTMLElement>(ref: RefObject<T | null>, keys: readonly string[]) {
  const sig = keys.join("\n");
  const last = useRef(sig);
  const before = useRef<Map<string, number> | null>(null);
  if (sig !== last.current) {
    // Render-phase read (like getSnapshotBeforeUpdate): the DOM still shows the last commit.
    before.current = ref.current ? positions(ref.current) : null;
    last.current = sig;
  }

  useLayoutEffect(() => {
    const list = ref.current;
    const prev = before.current;
    before.current = null;
    if (!list || !prev || reducedMotion()) return;
    for (const [key, top] of positions(list)) {
      const was = prev.get(key);
      if (was === undefined || Math.abs(was - top) < 1) continue;
      const el = list.querySelector<HTMLElement>(`:scope > [data-flip="${CSS.escape(key)}"]`);
      el?.animate([{ transform: `translateY(${was - top}px)` }, { transform: "translateY(0)" }], { duration: 550, easing: EASE_SPRING, id: "flip" });
    }
  }, [sig, ref]);
}

function positions(list: HTMLElement): Map<string, number> {
  const top = list.getBoundingClientRect().top;
  const out = new Map<string, number>();
  for (const el of list.querySelectorAll<HTMLElement>(":scope > [data-flip]")) out.set(el.dataset.flip!, el.getBoundingClientRect().top - top);
  return out;
}
