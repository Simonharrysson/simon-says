"use client";

import type { ComponentProps } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { IconCheck } from "./icons";

/**
 * shadcn/ui Checkbox (Radix): 20px, `--control-border` edge, ink when checked. Inside a form it
 * posts `name=on` like a native checkbox. `tone="green"` for consent.
 */
export function Checkbox({ className, tone = "ink", ...props }: ComponentProps<typeof CheckboxPrimitive.Root> & { tone?: "ink" | "green" }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-5 shrink-0 cursor-pointer place-content-center rounded-[4px] border border-control bg-surface transition-[background-color,border-color,transform] duration-120 ease-out hover:border-ink-2 active:scale-[0.92]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        tone === "ink"
          ? "data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=checked]:text-on-ink"
          : "data-[state=checked]:border-green data-[state=checked]:bg-green data-[state=checked]:text-on-green",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center">
        <IconCheck size={14} strokeWidth={2.75} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
