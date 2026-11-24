import type { ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/** Sticky top rail. `nav` holds page links; the wordmark leads home (or `homeHref`). */
export function SiteHeader({ nav, homeHref = "/" }: { nav?: ReactNode; homeHref?: string }) {
  return (
    <header className="site-header">
      <div className="page site-header__inner">
        <Wordmark href={homeHref} />
        {nav && <nav aria-label="Huvudmeny" className="site-header__nav">{nav}</nav>}
      </div>
    </header>
  );
}
