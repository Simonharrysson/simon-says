"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconMenu, IconX } from "@/components/ui/icons";
import { StartAction } from "./StartAction";

/**
 * The header's menu below 64rem: a sheet from the top (Radix Dialog: focus trapped, Esc and the
 * backdrop close it, focus goes back to the button). A link closes it and scrolls to its section.
 */
export function MobileMenu({ links, signedIn, signIn }: { links: { href: string; label: string }[]; signedIn: boolean; signIn: FormAction }) {
  const t = useTranslations("landing.nav");
  const [open, setOpen] = useState(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        className="press grid size-11 place-items-center rounded-md text-ink hover:bg-sunk min-[64rem]:hidden"
        aria-label={t("menu")}
      >
        <IconMenu size={22} />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-x-0 top-0 z-50 flex max-h-dvh flex-col overflow-y-auto rounded-b-2xl bg-surface pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[0_24px_48px_-24px_rgb(0_0_0/0.35)] outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-4 data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-4 data-[state=open]:fade-in-0 data-[state=open]:duration-300 data-[state=open]:ease-[var(--ease-spring)]"
        >
          <div className="flex min-h-16 items-center justify-between px-gutter">
            <DialogPrimitive.Title className="text-sm font-medium text-ink-3">{t("menuTitle")}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{t("label")}</DialogPrimitive.Description>
            <DialogPrimitive.Close className="press grid size-11 place-items-center rounded-md text-ink hover:bg-sunk" aria-label={t("close")}>
              <IconX size={22} />
            </DialogPrimitive.Close>
          </div>
          <nav aria-label={t("label")} className="flex flex-col px-gutter">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="press-row flex min-h-14 items-center border-b border-line text-xl font-semibold tracking-[-0.02em] text-ink no-underline hover:no-underline"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="mt-6 flex flex-col gap-2 px-gutter">
            <StartAction signedIn={signedIn} signIn={signIn} block />
            {!signedIn && (
              <a href="/login" className="press inline-flex min-h-12 items-center justify-center rounded-md text-base font-medium text-ink-2 no-underline hover:bg-sunk hover:text-ink hover:no-underline">
                {t("signIn")}
              </a>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
