import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet";
export type ButtonSize = "sm" | "md" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the label for width and sets aria-busy. */
  loading?: boolean;
  icon?: ReactNode;
  /** Icon-only button: `children` becomes the accessible label (visually hidden). */
  iconOnly?: boolean;
  block?: boolean;
}

export function buttonClass({ variant = "secondary", size = "md", iconOnly, block }: Common, extra?: string) {
  return cx(
    "btn",
    variant !== "secondary" && `btn--${variant}`,
    size !== "md" && `btn--${size}`,
    iconOnly && "btn--icon",
    block && "btn--block",
    extra,
  );
}

function Inner({ icon, iconOnly, loading, children }: Common & { children?: ReactNode }) {
  return (
    <>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {iconOnly ? <span className="visually-hidden">{children}</span> : <span className="btn__label">{children}</span>}
    </>
  );
}

export function Button({
  variant,
  size,
  loading,
  icon,
  iconOnly,
  block,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, iconOnly, block }, className)}
      disabled={disabled || loading}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      title={iconOnly && typeof children === "string" ? children : rest.title}
      {...rest}
    >
      <Inner icon={icon} iconOnly={iconOnly} loading={loading}>
        {children}
      </Inner>
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  icon,
  iconOnly,
  block,
  className,
  children,
  ...rest
}: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass({ variant, size, iconOnly, block }, className)} {...rest}>
      <Inner icon={icon} iconOnly={iconOnly}>
        {children}
      </Inner>
    </a>
  );
}
