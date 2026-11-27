"use client";

import { LazyMotion, MotionConfig, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING } from "@/lib/motion";

const loadFeatures = () => import("./features").then((m) => m.default);

/**
 * Motion for the whole app: `m` components only (`strict`), the animation features fetched after
 * hydration in their own chunk, and every animation instant under prefers-reduced-motion
 * (opacity and height too, not only movement: the e2e suite and axe read final states).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig transition={reduce ? { duration: 0 } : SPRING}>{children}</MotionConfig>
    </LazyMotion>
  );
}
