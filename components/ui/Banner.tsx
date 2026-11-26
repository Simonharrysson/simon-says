import type { ReactNode } from "react";
import { Alert, AlertAction, AlertBody, AlertIcon, AlertTitle } from "./alert";
import { IconAlert, IconCheck, IconInfo } from "./icons";

export type BannerTone = "info" | "success" | "warning" | "danger" | "neutral";

const icons: Record<BannerTone, ReactNode> = {
  info: <IconInfo />,
  success: <IconCheck />,
  warning: <IconAlert />,
  danger: <IconAlert />,
  neutral: <IconInfo />,
};

/**
 * Inline message on the shadcn Alert. `danger`/`warning` announce assertively (role="alert"); the
 * others politely (role="status"). Pass `live={false}` for static explanations. `loud` is the
 * stopped live meeting (the loudest thing on the page).
 */
export function Banner({
  tone = "info",
  title,
  children,
  action,
  icon,
  live = true,
  loud,
  className,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  live?: boolean;
  loud?: boolean;
  className?: string;
}) {
  const role = !live ? undefined : tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <Alert tone={tone} loud={loud} className={className} role={role}>
      <AlertIcon>{icon ?? icons[tone]}</AlertIcon>
      <AlertBody>
        {title && <AlertTitle className={loud ? "text-lg" : undefined}>{title}</AlertTitle>}
        {children && (typeof children === "string" ? <p>{children}</p> : children)}
      </AlertBody>
      {action ? <AlertAction>{action}</AlertAction> : <span />}
    </Alert>
  );
}
