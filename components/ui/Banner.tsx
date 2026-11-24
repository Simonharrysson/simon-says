import type { ReactNode } from "react";
import { IconAlert, IconCheck, IconInfo } from "./icons";
import { cx } from "./cx";

export type BannerTone = "info" | "success" | "warning" | "danger" | "neutral";

const icons: Record<BannerTone, ReactNode> = {
  info: <IconInfo />,
  success: <IconCheck />,
  warning: <IconAlert />,
  danger: <IconAlert />,
  neutral: <IconInfo />,
};

/**
 * Inline message. `danger`/`warning` announce assertively (role="alert"); the others
 * politely (role="status"). Pass `live={false}` for static explanations.
 */
export function Banner({
  tone = "info",
  title,
  children,
  action,
  icon,
  live = true,
  className,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  live?: boolean;
  className?: string;
}) {
  const role = !live ? undefined : tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <div className={cx("banner", tone !== "info" && `banner--${tone}`, className)} role={role}>
      <span className="banner__icon">{icon ?? icons[tone]}</span>
      <div className="banner__body">
        {title && <span className="banner__title">{title}</span>}
        {children && (typeof children === "string" ? <p>{children}</p> : children)}
      </div>
      {action ? <div className="banner__action">{action}</div> : <span />}
    </div>
  );
}
