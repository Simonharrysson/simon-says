"use client";

import { LazyMotion } from "motion/react";
import type { ReactNode } from "react";

let ready = false;
const loadFeatures = () =>
  import("./features").then((m) => {
    ready = true;
    return m.default;
  });

/**
 * True once motion's animation features have loaded. Until then (or if the chunk never arrives)
 * a new element must mount in its final, visible state: an `initial` would stay applied.
 */
export const motionReady = () => ready;

/**
 * Motion for a subtree: `m` components only (`strict`), the animation features fetched in their
 * own chunk after hydration. Only where lists animate (not in the root layout), so a page
 * without them carries no motion code.
 */
export function Lazy({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      {children}
    </LazyMotion>
  );
}
