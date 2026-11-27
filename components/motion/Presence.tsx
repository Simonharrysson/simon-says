"use client";

import { AnimatePresence, useIsPresent, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type { ComponentProps, ReactNode } from "react";
import { SPRING, SPRING_EXIT } from "@/lib/motion";
import { Lazy, motionReady } from "./Lazy";

/**
 * Rows that come and go: a new row opens to its height and fades in, a removed one fades and
 * closes (height, so the rows and panels below follow it in real layout, with nothing jumping).
 * Rows already there when the list mounts don't animate. Children are keyed <PresenceLi>s.
 */
export function Presence({ children }: { children: ReactNode }) {
  return (
    <Lazy>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </Lazy>
  );
}

const rowVariants = {
  out: { height: 0, opacity: 0, overflow: "hidden" },
  in: { height: "auto", opacity: 1, transition: SPRING, transitionEnd: { overflow: "visible" } },
  gone: { height: 0, opacity: 0, overflow: "hidden", transition: SPRING_EXIT },
} as const;
// Reduced motion: the same states, at once .
const instantVariants = {
  ...rowVariants,
  in: { ...rowVariants.in, transition: { duration: 0 } },
  gone: { ...rowVariants.gone, transition: { duration: 0 } },
} as const;

type Props<T extends "li" | "div"> = Omit<ComponentProps<(typeof m)[T]>, "initial" | "animate" | "exit" | "variants">;

/**
 * A list row for <Presence> (or any AnimatePresence): an `li` with the open/close animation.
 * While it closes it carries `data-exiting`, so the row after it can drop its separator
 * (app/globals.css "Rows that close"). Before motion's features load it mounts as it is.
 */
export function PresenceLi(props: Props<"li">) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  return (
    <m.li
      variants={reduce ? instantVariants : rowVariants}
      initial={motionReady() ? "out" : false}
      animate="in"
      exit="gone"
      data-exiting={present ? undefined : ""}
      {...props}
    />
  );
}

/** The same for a block that appears and goes (inside an AnimatePresence). */
export function PresenceDiv(props: Props<"div">) {
  const reduce = useReducedMotion();
  return <m.div variants={reduce ? instantVariants : rowVariants} initial={motionReady() ? "out" : false} animate="in" exit="gone" {...props} />;
}
