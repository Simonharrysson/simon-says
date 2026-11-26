"use client";

import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Switch (Radix), restyled to the tokens: an on/off that takes effect at once (no Save
 * button). 40×24 track with a `--control-border` edge, ink when on; the label next to it says
 * what it does. Use `Check` for choices that are saved with a form.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-control bg-sunk p-0.5 transition-colors duration-120",
        "data-[state=checked]:border-ink data-[state=checked]:bg-ink",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-[18px] rounded-full bg-ink-3 transition-transform duration-120 ease-out motion-reduce:transition-none",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-ink",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
