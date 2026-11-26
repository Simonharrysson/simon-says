"use client";

import type { ComponentProps, ReactNode } from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui DropdownMenu (Radix): arrow keys move, Enter/Space choose, Esc closes and focus returns
 * to the trigger. A floating surface (`shadow-lift`). Items are 44px on phones.
 */
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, sideOffset = 6, align = "end", ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={16}
        className={cn(
          "z-50 w-[min(20rem,calc(100vw-2rem))] rounded-lg bg-surface p-1 text-ink shadow-lift outline-none",
          "duration-120 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

/** One choice: a name and, optionally, a short grey line under it. */
export function DropdownMenuItem({
  className,
  hint,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { hint?: ReactNode }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex min-h-9 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-3 py-2 text-sm font-medium outline-none select-none max-md:min-h-11",
        "data-[highlighted]:bg-sunk data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span>{children}</span>
      {hint && <span className="text-xs font-normal text-ink-3">{hint}</span>}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

/** A note inside the menu (not focusable). */
export function DropdownMenuNote({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label data-slot="dropdown-menu-note" className={cn("px-3 py-2 text-xs text-ink-3", className)} {...props} />;
}
