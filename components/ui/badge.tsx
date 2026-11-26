import type { ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "live" | "alert" | "success" | "info";

/** shadcn/ui Badge, toned: a label in a tinted pill. No dots: the text carries the meaning. */
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center rounded-full px-2 py-0.5 text-2xs leading-[1.35] font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-sunk text-ink-2",
        live: "bg-red-wash text-red",
        // Static red: needs you (not live).
        alert: "bg-red-wash text-red",
        success: "bg-green-wash text-green",
        info: "bg-blue-wash text-blue",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

/** A status of a meeting, a role, a state. The tint only supports the words. */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)}>
      {children}
    </span>
  );
}
