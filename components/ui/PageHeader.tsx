import type { ReactNode } from "react";
import { IconArrowLeft } from "./icons";

/** The page title: 32px, wraps anywhere. */
export const pageTitleClass = "text-2xl wrap-anywhere";

export function PageHeader({
  title,
  meta,
  actions,
  back,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {back && (
          <a className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 no-underline hover:text-ink" href={back.href}>
            <IconArrowLeft size={16} />
            {back.label}
          </a>
        )}
        <h1 className={pageTitleClass}>{title}</h1>
        {meta && <div className="mt-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}
