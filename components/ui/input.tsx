import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** The control look shared by Input and NativeSelect: surface, `--control-border` edge (≥ 3:1), 6px radius. */
export const controlClass = cn(
  "min-h-10 w-full min-w-0 rounded-md border border-control bg-surface px-3 text-sm text-ink max-md:min-h-11",
  "transition-[border-color,box-shadow] duration-120 placeholder:text-ink-3 hover:border-ink-3",
  // Focus: a 2px blue ring outside a 1px gap.
  "focus-visible:border-ink-3 focus-visible:shadow-[0_0_0_1px_var(--surface),0_0_0_3px_var(--focus)] focus-visible:outline-none",
  "aria-invalid:border-red disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3",
);

/** shadcn/ui Input. `mono` for ids and links. */
export function Input({ className, mono, ...props }: ComponentProps<"input"> & { mono?: boolean }) {
  return <input data-slot="input" className={cn(controlClass, mono && "font-mono", className)} {...props} />;
}
