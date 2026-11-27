import { AppLink } from "@/components/ui/AppLink";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Button with Simon Says' variants. Primary = ink, secondary = surface with a
 * `--control-border` outline (≥ 3:1), ghost = transparent. Red only for destructive:
 * `danger` (filled), `danger-quiet` (red text), `danger-ghost` (grey list trash icons that turn
 * red on hover/focus). The shadcn names (`default`, `outline`, `destructive`, `link`) are aliases.
 * Phones (< 48rem): every button is a 44px target.
 */
const buttonCva = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 min-h-10 max-md:min-h-11",
    "text-sm leading-none font-medium whitespace-nowrap no-underline select-none hover:no-underline",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-120 ease-out active:scale-[0.98]",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "data-[loading=true]:cursor-progress data-[loading=true]:opacity-100 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "border-ink bg-ink text-on-ink hover:bg-[color-mix(in_srgb,var(--ink)_85%,var(--surface))]",
        secondary: "border-control bg-surface text-ink hover:bg-sunk",
        ghost: "border-transparent bg-transparent text-ink-2 hover:bg-sunk hover:text-ink",
        danger: "border-red bg-red text-on-red hover:bg-[color-mix(in_srgb,var(--red)_88%,var(--ink))]",
        "danger-quiet": "border-transparent bg-transparent text-red hover:bg-red-wash",
        "danger-ghost":
          "border-transparent bg-transparent text-ink-3 hover:bg-red-wash hover:text-red focus-visible:bg-red-wash focus-visible:text-red",
        // shadcn's names
        default: "border-ink bg-ink text-on-ink hover:bg-[color-mix(in_srgb,var(--ink)_85%,var(--surface))]",
        outline: "border-control bg-surface text-ink hover:bg-sunk",
        destructive: "border-red bg-red text-on-red hover:bg-[color-mix(in_srgb,var(--red)_88%,var(--ink))]",
        link: "min-h-0 border-transparent bg-transparent px-0 text-blue underline underline-offset-[0.2em] hover:underline",
      },
      size: {
        sm: "min-h-8 px-2",
        md: "",
        // Large stays big on purpose: Paus/Fortsätt on the live page is read across a table.
        lg: "min-h-12 px-6 text-base max-md:min-h-12",
      },
      iconOnly: { true: "w-10 px-0 max-md:w-11", false: "" },
      block: { true: "w-full", false: "" },
    },
    compoundVariants: [{ size: "sm", iconOnly: true, className: "w-8" }],
    defaultVariants: { variant: "secondary", size: "md", iconOnly: false, block: false },
  },
);

type Variants = VariantProps<typeof buttonCva>;

/** The button classes, merged (so a size's padding replaces the base padding), for links styled as buttons. */
export const buttonVariants = (props?: Variants) => cn(buttonCva(props));
export type ButtonVariant = NonNullable<Variants["variant"]>;
export type ButtonSize = NonNullable<Variants["size"]>;

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

/** The loading spinner: a ring with a gap, in the text colour. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[1em] shrink-0 animate-[spin_700ms_linear_infinite] rounded-full border-2 border-current border-r-transparent",
        className,
      )}
    />
  );
}

function Inner({ icon, iconOnly, loading, children }: Common & { children?: ReactNode }) {
  return (
    <>
      {loading ? <Spinner /> : icon}
      {iconOnly ? <span className="sr-only">{children}</span> : <span className={loading ? "opacity-55" : undefined}>{children}</span>}
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
  asChild,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; asChild?: boolean }) {
  const classes = cn(buttonVariants({ variant, size, iconOnly, block }), className);
  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type}
      data-slot="button"
      className={classes}
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
  href,
  ...rest
}: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <AppLink data-slot="button" className={cn(buttonVariants({ variant, size, iconOnly, block }), className)} href={href ?? ""} {...rest}>
      <Inner icon={icon} iconOnly={iconOnly}>
        {children}
      </Inner>
    </AppLink>
  );
}
