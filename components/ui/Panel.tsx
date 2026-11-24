import type { ReactNode } from "react";
import { cx } from "./cx";

/** A sheet on the board. `flush` for lists that run edge to edge. */
export function Panel({
  title,
  titleId,
  actions,
  flush,
  sunk,
  children,
  className,
  as: Tag = "section",
  id,
}: {
  title?: ReactNode;
  titleId?: string;
  actions?: ReactNode;
  flush?: boolean;
  sunk?: boolean;
  children?: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
  id?: string;
}) {
  return (
    <Tag
      id={id}
      className={cx("panel", flush && "panel--flush", sunk && "panel--sunk", className)}
      aria-labelledby={title && titleId ? titleId : undefined}
    >
      {(title || actions) && (
        <div className="panel__header">
          {title && (
            <h2 className="panel__title" id={titleId}>
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </Tag>
  );
}
