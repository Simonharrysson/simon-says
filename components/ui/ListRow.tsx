import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A list row: hairline between rows (not above the first), 56px tall, padded like a panel. */
export const rowClass = "flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0";
export const rowMainClass = "flex min-w-0 flex-1 flex-col gap-[0.1rem]";
export const rowTitleClass = "font-medium wrap-anywhere";
export const rowMetaClass = "text-xs text-ink-3";
export const rowActionsClass = "flex flex-none items-center gap-1";

/** One row in a list: leading slot, title + meta, trailing actions. Use inside a `<ul>`. */
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
      <span className={rowMainClass}>
        <span className={rowTitleClass}>{title}</span>
        {meta && <span className={rowMetaClass}>{meta}</span>}
      </span>
      {actions && <span className={rowActionsClass}>{actions}</span>}
    </>
  );
  return (
    <li>
      {href ? (
        <a
          className={cn(
            rowClass,
            "group/row text-inherit no-underline transition-colors duration-120 hover:bg-sunk hover:no-underline focus-visible:rounded-none focus-visible:outline-offset-[-2px]",
          )}
          href={href}
        >
          {content}
        </a>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
    </li>
  );
}
