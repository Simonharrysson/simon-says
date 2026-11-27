"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type { ComponentProps, ReactNode } from "react";
import { SPRING_EXIT } from "@/lib/motion";

/**
 * Rows that come and go: a new row opens to its height and fades in, a removed one fades and
 * closes (height, so the rows and panels below follow it in real layout, with nothing jumping).
 * Rows already there when the list mounts don't animate. Children are keyed <PresenceLi>s.
 */
export function Presence({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

const rowVariants = {
  out: { height: 0, opacity: 0, overflow: "hidden" },
  in: { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } },
  gone: { height: 0, opacity: 0, overflow: "hidden", transition: SPRING_EXIT },
} as const;
// Reduced motion: the same states, at once (a variant's own transition beats MotionConfig's).
const instantVariants = { ...rowVariants, gone: { ...rowVariants.gone, transition: { duration: 0 } } } as const;

type Props<T extends "li" | "div"> = Omit<ComponentProps<(typeof m)[T]>, "initial" | "animate" | "exit" | "variants">;

/** A list row for <Presence> (or any AnimatePresence): an `li` with the open/close animation. */
export function PresenceLi(props: Props<"li">) {
  const reduce = useReducedMotion();
  return <m.li variants={reduce ? instantVariants : rowVariants} initial="out" animate="in" exit="gone" {...props} />;
}

/** The same for a block that appears and goes (inside an AnimatePresence). */
export function PresenceDiv(props: Props<"div">) {
  const reduce = useReducedMotion();
  return <m.div variants={reduce ? instantVariants : rowVariants} initial="out" animate="in" exit="gone" {...props} />;
}
