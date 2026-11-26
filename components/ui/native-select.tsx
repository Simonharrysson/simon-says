import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { IconChevronDown } from "./icons";
import { controlClass } from "./input";

/**
 * shadcn/ui NativeSelect: a real `<select>` (keyboard, mobile pickers and form posts unchanged),
 * drawn like an Input with a chevron. `className` goes on the wrapper (width), the rest on the select.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className={cn("relative w-full min-w-0", className)}>
      <select data-slot="native-select" className={cn(controlClass, "cursor-pointer appearance-none pr-9")} {...props} />
      <IconChevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-2" />
    </div>
  );
}
