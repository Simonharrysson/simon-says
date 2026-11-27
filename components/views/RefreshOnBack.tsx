"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";

/**
 * Back/forward between signed-in pages shows the router's cached page at once (instant, with
 * its scroll position), then refreshes it in the background: something done on another page
 * (a task ticked, a meeting ended) is never shown stale for long. Before client navigation,
 * back was a full reload and always fresh; this keeps that promise.
 *
 * Only for a real change of page: history within a page (a förening tab's `?flik=`, an anchor)
 * keeps what it shows (the tab shell refreshes its own way), so it costs no server render and
 * no calendar call.
 */
export function RefreshOnBack() {
  const router = useRouter();
  const pathname = usePathname();
  const shownPath = useRef(pathname);
  useEffect(() => {
    shownPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const onPop = () => {
      // The router has not re-rendered yet: shownPath is still the page being left.
      if (window.location.pathname === shownPath.current) return;
      // After the router has restored the page.
      setTimeout(() => startTransition(() => router.refresh()), 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [router]);
  return null;
}
