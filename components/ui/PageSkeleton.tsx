import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { cardClass } from "./card";
import { Skeleton } from "./skeleton";

// Route skeletons (app/(app)/**/loading.tsx), built from the same boxes as the real pages: the
// page column's width and gap, PageHeader's 32px title and mb-8, Panel's padding, ListRow's
// 56px rows. A skeleton that matches the page keeps the header, tabs and footer where they
// will be when the content arrives (no layout shift).

/** The page column, announced as loading. `width`: the page's own max-width class. */
export function SkeletonPage({ width, gap = "gap-6", children }: { width: string; gap?: string; children: ReactNode }) {
  const t = useTranslations("common");
  return (
    <div className={cn("mx-auto flex w-full flex-col px-gutter", width, gap)} aria-busy="true">
      <span className="sr-only" role="status">
        {t("loading")}
      </span>
      {children}
    </div>
  );
}

/** PageHeader: optional back link, the title, optional meta lines and a trailing action. */
export function SkeletonHeader({ back, meta = 0, action, logo, titleWidth = "w-[min(18rem,70%)]" }: { back?: boolean; meta?: number; action?: boolean; logo?: boolean; titleWidth?: string }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        {back && <Skeleton className="mb-3 h-5 w-24" />}
        <div className="flex items-center gap-4">
          {logo && <Skeleton className="size-12 flex-none rounded-lg" />}
          <Skeleton className={cn("h-[2.3rem]", titleWidth)} />
        </div>
        {meta > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {Array.from({ length: meta }, (_, i) => (
              <Skeleton key={i} className={cn("h-4", i === meta - 1 ? "w-[min(16rem,55%)]" : "w-[min(26rem,85%)]")} />
            ))}
          </div>
        )}
      </div>
      {action && <Skeleton className="h-12 w-40 rounded-md" />}
    </div>
  );
}

/** A Panel: its title line, then `rows` list rows (flush) or a block of `height`. */
export function SkeletonPanel({ rows, height = "h-24", titleWidth = "w-32" }: { rows?: number; height?: string; titleWidth?: string }) {
  return (
    <div className={cn(cardClass, "pointer-events-none", rows ? "" : "p-6")}>
      <div className={cn("mb-4", rows ? "px-6 pt-6" : "")}>
        <Skeleton className={cn("h-6", titleWidth)} />
      </div>
      {rows ? (
        <ul>
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 first:border-t-0">
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className={cn("h-4", i % 2 ? "w-[45%]" : "w-[60%]")} />
                <Skeleton className="h-3 w-[30%]" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Skeleton className={cn("w-full", height)} />
      )}
    </div>
  );
}
