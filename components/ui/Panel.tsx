import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { cardClass, CardHeader, CardTitle } from "./card";

/** Panel padding helpers for `flush` panels: intro text, padded content, a footer note. */
export const panelIntroClass = "-mt-2 px-6 pb-4";
export const panelPadClass = "px-6 pb-6";
export const panelFootClass = "border-t border-line px-6 pt-3 pb-4";

/** A sheet on the board (a shadcn Card). `flush` for lists that run edge to edge. */
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
      data-slot="card"
      className={cn(cardClass, !flush && "p-6", sunk && "bg-board", className)}
      aria-labelledby={title && titleId ? titleId : undefined}
    >
      {(title || actions) && (
        <CardHeader className={cn("mb-4", flush && "px-6 pt-6")}>
          {title && <CardTitle id={titleId}>{title}</CardTitle>}
          {actions}
        </CardHeader>
      )}
      {children}
    </Tag>
  );
}
