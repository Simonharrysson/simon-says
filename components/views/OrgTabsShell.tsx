"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, addTransitionType, startTransition, useEffect, useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/** Föreningar: moten | oversikt | installningar. Företag (0050): moten | kunder | personer | installningar. */
export type OrgTabId = "moten" | "oversikt" | "installningar" | "kunder" | "personer";

/** How long next keeps a full prefetch (staleTimes.static, 5 min): only then is it fetched again. */
const KEPT_MS = 5 * 60_000;

/**
 * The förening page's tab bar and panels. The tabs stay real links (`?flik=`, shareable and
 * reloadable; the server still decides which tab a URL shows, see lib/orgs/tabs.ts), but a click
 * no longer waits for the server:
 *
 * - the tab is marked at once (optimistic `aria-current`) and its panel shows: the last visited
 *   content, kept mounted but hidden in <Activity> (state, open folds and drafts survive), or a
 *   panel-shaped skeleton on a first visit;
 * - kept or prefetched content may be old (a meeting ended meanwhile), so until the server's
 *   fresh render has replaced it, it is inert (no "Fortsätt", no delete) and dims after 200 ms;
 *   content from a prefetch is refreshed as soon as it shows;
 * - hovering, focusing or touching a tab prefetches it in full, so a first visit is usually
 *   instant too. Nothing is prefetched without intent: a page view costs one render, as before.
 */
export function OrgTabsShell({
  active,
  tabs,
  label,
  loadingLabel,
  between,
  children,
}: {
  /** The tab the server rendered (the source of truth; the optimistic tab falls back to it). */
  active: OrgTabId;
  tabs: { id: OrgTabId; label: string; href: string }[];
  label: string;
  loadingLabel: string;
  /** Between the tab bar and the panel: the page notice and the Kom igång card. */
  between?: ReactNode;
  /** The active tab's panel, rendered by the server. */
  children: ReactNode;
}) {
  const router = useRouter();
  const [shown, setShown] = useOptimistic(active);
  // Each visited tab's last server render. Updated during render when the server sends a new one.
  const [panels, setPanels] = useState<Partial<Record<OrgTabId, ReactNode>>>(() => ({ [active]: children }));
  if (panels[active] !== children) setPanels((p) => ({ ...p, [active]: children }));

  const prefetchedAt = useRef<Partial<Record<OrgTabId, number>>>({});
  const refreshFor = useRef<OrgTabId | null>(null);
  const warm = (tab: { id: OrgTabId; href: string }) => {
    if (tab.id === active) return;
    // Another hover while next still holds the prefetch is a cache hit, not new data: keep the
    // first prefetch's time, so a later click knows how old what it shows is.
    const at = prefetchedAt.current[tab.id];
    if (at && Date.now() - at < KEPT_MS) return;
    prefetchedAt.current[tab.id] = Date.now();
    // A full prefetch (the page's data, not only its loading state). `kind` is next's
    // PrefetchKind.FULL; the public type does not list it yet.
    router.prefetch(tab.href, { kind: "full" } as Parameters<typeof router.prefetch>[1]);
  };
  // A tab served from a prefetch (as old as the prefetch) is refreshed once it shows; the
  // refresh also drops that cache entry, so the next hover prefetches anew.
  const [refreshing, startRefresh] = useTransition();
  useEffect(() => {
    if (refreshFor.current === active) {
      refreshFor.current = null;
      delete prefetchedAt.current[active];
      startRefresh(() => router.refresh());
    }
  }, [active, router]);

  return (
    <>
      <nav aria-label={label} className="-mt-2 flex gap-1 border-b border-line">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            prefetch={false}
            scroll={false}
            transitionTypes={["tab"]}
            aria-current={tab.id === shown ? "page" : undefined}
            onMouseEnter={() => warm(tab)}
            onFocus={() => warm(tab)}
            onTouchStart={() => warm(tab)}
            onNavigate={() => {
              refreshFor.current = prefetchedAt.current[tab.id] ? tab.id : null;
              startTransition(() => {
                addTransitionType("tab");
                setShown(tab.id);
              });
            }}
            className="relative -mb-px inline-flex min-h-10 flex-none items-center rounded-t-md px-3 text-sm font-medium text-ink-3 no-underline transition-colors duration-150 ease-out after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-ink after:transition-transform after:duration-200 after:ease-out hover:text-ink hover:no-underline focus-visible:outline-offset-[-2px] aria-[current=page]:text-ink aria-[current=page]:after:scale-x-100 max-md:min-h-11"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {between}
      {tabs.map((tab) => {
        const panel = panels[tab.id];
        if (panel === undefined && tab.id !== shown) return null;
        // Not yet confirmed by the server: the navigation is pending, or the prefetched copy is
        // being refreshed.
        const stale = panel !== undefined && tab.id === shown && (shown !== active || refreshing || refreshFor.current === tab.id);
        return (
          <Activity key={tab.id} mode={tab.id === shown ? "visible" : "hidden"}>
            {panel === undefined ? (
              <TabSkeleton tab={tab.id} label={loadingLabel} />
            ) : (
              <div
                className="contents [&>*]:transition-opacity [&>*]:duration-200 [&[data-stale]>*]:opacity-60 [&[data-stale]>*]:delay-200"
                data-stale={stale || undefined}
                inert={stale}
                aria-busy={stale || undefined}
              >
                {panel}
              </div>
            )}
          </Activity>
        );
      })}
    </>
  );
}

/** A first visit's placeholder, shaped like the tab's panels so nothing jumps when it arrives. */
function TabSkeleton({ tab, label }: { tab: OrgTabId; label: string }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {tab === "oversikt" ? (
        <>
          <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
            <Skeleton className="h-28 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
          </div>
          <Skeleton className="h-56 rounded-lg" />
        </>
      ) : tab === "installningar" ? (
        <>
          <Skeleton className="h-72 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </>
      ) : (
        <>
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-80 rounded-lg" />
        </>
      )}
    </div>
  );
}
