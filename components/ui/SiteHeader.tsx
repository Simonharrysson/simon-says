import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/** A top-rail link (Föreningar, Konto, Logga in); `aria-current="page"` marks where you are. */
export const navLinkClass =
  "inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-ink-2 no-underline transition-colors duration-120 hover:bg-sunk hover:text-ink hover:no-underline aria-[current=page]:bg-sunk aria-[current=page]:text-ink";

/**
 * Sticky top rail. `nav` holds page links; the wordmark leads home (or `homeHref`). `wideNav`:
 * more links than fit beside the wordmark on a phone, so there the links take a row of their own.
 */
export function SiteHeader({ nav, homeHref = "/", wideNav = false }: { nav?: ReactNode; homeHref?: string; wideNav?: boolean }) {
  const t = useTranslations("common");
  return (
    <header style={{ viewTransitionName: "site-header" }} className="sticky top-0 z-20 border-b border-line bg-[color-mix(in_srgb,var(--board)_92%,transparent)] backdrop-blur-[10px] backdrop-saturate-[1.4]">
      <div className={`mx-auto flex min-h-16 w-full max-w-page items-center gap-4 px-gutter ${wideNav ? "max-[30rem]:flex-wrap max-[30rem]:gap-y-0 max-[30rem]:pb-1" : ""}`}>
        <Wordmark href={homeHref} />
        {nav && (
          <nav aria-label={t("mainNav")} className={`ml-auto flex items-center gap-1 ${wideNav ? "max-[30rem]:ml-0 max-[30rem]:basis-full max-[30rem]:justify-between max-[30rem]:gap-0" : ""}`}>
            {nav}
          </nav>
        )}
      </div>
    </header>
  );
}
