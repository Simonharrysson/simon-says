import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Card: a flat surface with a 1px hairline ring (adds no size), 8px radius. */
export const cardClass = "rounded-lg bg-surface text-ink shadow-panel";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn(cardClass, className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-lg tracking-[-0.02em]", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-ink-3", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6 pb-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("border-t border-line px-6 pt-3 pb-4", className)} {...props} />;
}
