import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Skeleton: a grey shimmer while a page reads its data. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--surface-sunk)_0%,var(--line)_50%,var(--surface-sunk)_100%)] bg-size-[200%_100%]",
        className,
      )}
      {...props}
    />
  );
}
