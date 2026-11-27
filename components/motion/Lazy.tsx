"use client";

import { LazyMotion } from "motion/react";
import type { ReactNode } from "react";

const loadFeatures = () => import("./features").then((m) => m.default);

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
