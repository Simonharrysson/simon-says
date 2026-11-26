import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Alert, toned: a tinted wash with a faint ring in the tone. Red only when the user must
 * act; amber for warnings that fix themselves. The role is the caller's (Banner sets it).
 */
export const alertVariants = cva(
  "grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-lg px-4 py-3 text-sm text-ink max-[30rem]:grid-cols-[auto_1fr]",
  {
    variants: {
      tone: {
        info: "bg-blue-wash shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--blue)_22%,transparent)] [--tone:var(--blue)]",
        success: "bg-green-wash shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--green)_22%,transparent)] [--tone:var(--green)]",
        warning: "bg-amber-wash shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--amber)_22%,transparent)] [--tone:var(--amber)]",
        danger: "bg-red-wash shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)] [--tone:var(--red)]",
        neutral: "bg-surface shadow-[inset_0_0_0_1px_var(--line)] [--tone:var(--ink-2)]",
      },
      // The stopped live meeting: the loudest thing on the page.
      loud: { true: "px-6 py-4 text-base shadow-[inset_0_0_0_2px_var(--red)]", false: "" },
    },
    defaultVariants: { tone: "info", loud: false },
  },
);

export function Alert({ className, tone, loud, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ tone, loud }), className)} {...props} />;
}

/** The leading icon, in the tone colour. */
export function AlertIcon({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="alert-icon" className={cn("mt-[0.1rem] text-(--tone)", className)} {...props} />;
}

export function AlertBody({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-body" className={cn("flex flex-col gap-1 [&_p]:text-ink-2", className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="alert-title" className={cn("font-semibold", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="alert-description" className={className} {...props} />;
}

export function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("self-center max-[30rem]:col-span-full max-[30rem]:justify-self-start", className)}
      {...props}
    />
  );
}
