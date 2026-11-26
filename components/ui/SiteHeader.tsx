import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/** A top-rail link (Föreningar, Konto, Logga in); `aria-current="page"` marks where you are. */
export const navLinkClass =
  "inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-ink-2 no-underline transition-colors duration-120 hover:bg-sunk hover:text-ink hover:no-underline aria-[current=page]:bg-sunk aria-[current=page]:text-ink";

/** Sticky top rail. `nav` holds page links; the wordmark leads home (or `homeHref`). */
export function SiteHeader({ nav, homeHref = "/" }: { nav?: ReactNode; homeHref?: string }) {
  const t = useTranslations("common");
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-[color-mix(in_srgb,var(--board)_92%,transparent)] backdrop-blur-[10px] backdrop-saturate-[1.4]">
      <div className="mx-auto flex min-h-16 w-full max-w-page items-center gap-4 px-gutter">
        <Wordmark href={homeHref} />
        {nav && (
          <nav aria-label={t("mainNav")} className="ml-auto flex items-center gap-1">
            {nav}
          </nav>
        )}
      </div>
    </header>
  );
}
