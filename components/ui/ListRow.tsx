import type { ReactNode } from "react";

/** One row in a list: leading slot, title + meta, trailing actions. Use inside `<ul className="list">`. */
export function ListRow({
  leading,
  title,
  meta,
  actions,
  href,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  href?: string;
}) {
  const content = (
    <>
      {leading}
      <span className="row__main">
        <span className="row__title">{title}</span>
        {meta && <span className="row__meta">{meta}</span>}
      </span>
      {actions && <span className="row__actions">{actions}</span>}
    </>
  );
  return (
    <li>
      {href ? (
        <a className="row" href={href}>
          {content}
        </a>
      ) : (
        <div className="row">{content}</div>
      )}
    </li>
  );
}
