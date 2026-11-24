import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "live" | "alert" | "success" | "info";

const magnet: Record<BadgeTone, string> = {
  neutral: "magnet magnet--rail",
  live: "magnet",
  alert: "magnet magnet--red",
  success: "magnet magnet--green",
  info: "magnet magnet--blue",
};

/** A small magnet with a label: status of a meeting, a role, a state. */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("badge", tone !== "neutral" && `badge--${tone}`, className)}>
      <span className={magnet[tone]} aria-hidden="true" />
      {children}
    </span>
  );
}
