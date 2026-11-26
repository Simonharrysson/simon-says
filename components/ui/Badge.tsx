import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "live" | "alert" | "success" | "info";

/** A label in a tinted pill: status of a meeting, a role, a state. The text carries the meaning; the tint only supports it. */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cx("badge", tone !== "neutral" && `badge--${tone}`, className)}>{children}</span>;
}
