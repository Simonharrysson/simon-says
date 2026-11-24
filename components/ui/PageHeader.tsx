import type { ReactNode } from "react";
import { IconArrowLeft } from "./icons";

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
    <header className="page-header">
      <div>
        {back && (
          <a className="crumb" href={back.href}>
            <IconArrowLeft size={16} />
            {back.label}
          </a>
        )}
        <h1 className="page-header__title">{title}</h1>
        {meta && <div className="page-header__meta">{meta}</div>}
      </div>
      {actions && <div className="cluster">{actions}</div>}
    </header>
  );
}
