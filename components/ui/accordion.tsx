"use client";

import type { ComponentProps } from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { IconChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Accordion (Radix), restyled to the tokens: rows divided by hairlines (never a box per
 * row), the chevron turns, and the panel's height opens on the press spring (instant under
 * reduced motion, like every animation).
 */
export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn("border-b border-line", className)} {...props} />;
}

export function AccordionTrigger({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/acc flex min-h-16 flex-1 cursor-pointer items-center justify-between gap-6 py-4 text-left text-lg font-medium tracking-[-0.015em] text-ink transition-colors hover:text-ink-2",
          className,
        )}
        {...props}
      >
        {children}
        <IconChevronDown
          size={20}
          className="flex-none text-ink-3 transition-transform duration-[var(--dur-press)] ease-[var(--ease-press)] group-data-[state=open]/acc:rotate-180"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=closed]:duration-200 data-[state=open]:animate-accordion-down data-[state=open]:duration-[var(--dur-press)] data-[state=open]:ease-[var(--ease-press)]"
      {...props}
    >
      <div className={cn("max-w-[60ch] pb-6 text-ink-2", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
