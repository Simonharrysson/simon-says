"use client";

import { usePathname } from "next/navigation";
import { startTransition, useOptimistic } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { useTranslations } from "next-intl";
import { useSlider } from "@/components/motion/Slider";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { navLinkClass as baseLinkClass } from "@/components/ui/SiteHeader";

// Four links fit a 390px phone next to the wordmark only with less padding.
const navLinkClass = `${baseLinkClass} relative max-[30rem]:px-2`;

const SECTIONS = [
  { href: "/hem", key: "home" },
  { href: "/privat", key: "privat" },
  { href: "/orgs", key: "orgs" },
  { href: "/installningar", key: "account" },
] as const;

/**
 * Top-rail links for the logged-in area (Hem = Mina uppgifter, the page after sign-in). On phones
 * the email and Logga ut drop out (Logga ut is also on the Konto page), so the rail never scrolls
 * sideways. The current section's pill slides to a clicked link at once (optimistic, like the
 * förening tabs), and a hover pill follows the mouse (components/motion/Slider.tsx).
 */
export function AppNav({ email, signOut }: { email: string; signOut: FormAction }) {
  const t = useTranslations("common");
  const path = usePathname() ?? "";
  const [shownPath, setShownPath] = useOptimistic(path);
  const current = SECTIONS.find((s) => shownPath === s.href || shownPath.startsWith(`${s.href}/`))?.href;
  const slider = useSlider<HTMLSpanElement>(current);
  return (
    <>
      <span ref={slider.ref} className="relative flex items-center gap-1" data-slider={slider.ready || undefined} {...slider.hoverProps}>
        <span aria-hidden="true" data-slider-mark="hover" className="pointer-events-none absolute top-0 left-0 rounded-md bg-sunk" style={slider.hoverStyle} />
        <span aria-hidden="true" data-slider-mark="active" className="pointer-events-none absolute top-0 left-0 rounded-md bg-sunk" style={slider.activeStyle} />
        {SECTIONS.map((s) => (
          <AppLink
            key={s.href}
            className={navLinkClass}
            href={s.href}
            data-slider-key={s.href}
            aria-current={current === s.href ? "page" : undefined}
            // Urgent, so it lands with the click; the navigation's own transition settles it.
            onNavigate={() => startTransition(() => setShownPath(s.href))}
          >
            {t(s.key)}
          </AppLink>
        ))}
      </span>
      {email && (
        <span className="max-w-[14rem] truncate text-xs text-ink-3 max-md:hidden" title={email}>
          {email}
        </span>
      )}
      <form action={signOut} className="max-[30rem]:hidden">
        <SubmitButton variant="ghost" size="sm" pendingLabel={t("signingOut")}>
          {t("signOut")}
        </SubmitButton>
      </form>
    </>
  );
}
