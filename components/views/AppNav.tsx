"use client";

import { usePathname } from "next/navigation";
import { startTransition, useOptimistic } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { useTranslations } from "next-intl";
import { useSlider } from "@/components/motion/Slider";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconUser } from "@/components/ui/icons";
import { navLinkClass as baseLinkClass } from "@/components/ui/SiteHeader";
import { navSection, type NavSection } from "@/lib/nav/section";

// Four links fit a 390px phone next to the wordmark only with less padding. With Företag (five)
// the rail takes its own row on a phone (SiteHeader `wideNav`) and Konto shrinks to an icon.
const navLinkClass = `${baseLinkClass} relative max-[30rem]:px-2`;
const wideLinkClass = `${baseLinkClass} relative max-[30rem]:px-1.5`;

const SECTIONS: { href: NavSection; key: "home" | "privat" | "orgs" | "foretag" | "account" }[] = [
  { href: "/hem", key: "home" },
  { href: "/privat", key: "privat" },
  { href: "/orgs", key: "orgs" },
  { href: "/foretag", key: "foretag" },
  { href: "/installningar", key: "account" },
];

/**
 * Top-rail links for the logged-in area (Hem = Mina uppgifter, the page after sign-in). On phones
 * the email and Logga ut drop out (Logga ut is also on the Konto page), so the rail never scrolls
 * sideways. The current section's pill slides to a clicked link at once (optimistic, like the
 * förening tabs), and a hover pill follows the mouse (components/motion/Slider.tsx).
 * Företag shows only to members of a company or those who may create one (`companyIds`,
 * `showForetag` from the layout); a company's /orgs/<id> pages mark Företag, not Föreningar.
 */
export function AppNav({ email, signOut, showForetag = false, companyIds = [] }: { email: string; signOut: FormAction; showForetag?: boolean; companyIds?: string[] }) {
  const t = useTranslations("common");
  const path = usePathname() ?? "";
  const [shownPath, setShownPath] = useOptimistic(path);
  const current = navSection(shownPath, companyIds);
  const slider = useSlider<HTMLSpanElement>(current);
  const linkClass = showForetag ? wideLinkClass : navLinkClass;
  return (
    <>
      <span
        ref={slider.ref}
        className={`relative flex items-center gap-1 ${showForetag ? "max-[30rem]:flex-1 max-[30rem]:justify-between max-[30rem]:gap-0" : ""}`}
        data-slider={slider.ready || undefined}
        {...slider.hoverProps}
      >
        <span aria-hidden="true" data-slider-mark="hover" className="pointer-events-none absolute top-0 left-0 rounded-md bg-sunk" style={slider.hoverStyle} />
        <span aria-hidden="true" data-slider-mark="active" className="pointer-events-none absolute top-0 left-0 rounded-md bg-sunk" style={slider.activeStyle} />
        {SECTIONS.filter((s) => showForetag || s.href !== "/foretag").map((s) => (
          <AppLink
            key={s.href}
            className={linkClass}
            href={s.href}
            data-slider-key={s.href}
            aria-current={current === s.href ? "page" : undefined}
            // Urgent, so it lands with the click; the navigation's own transition settles it.
            onNavigate={() => startTransition(() => setShownPath(s.href))}
          >
            {showForetag && s.key === "account" ? (
              <>
                <IconUser className="hidden max-[30rem]:block" />
                <span className="max-[30rem]:sr-only">{t(s.key)}</span>
              </>
            ) : (
              t(s.key)
            )}
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
