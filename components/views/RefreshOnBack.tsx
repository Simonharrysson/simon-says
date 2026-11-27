"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

/**
 * Back/forward between signed-in pages shows the router's cached page at once (instant, with
 * its scroll position), then refreshes it in the background: something done on another page
 * (a task ticked, a meeting ended) is never shown stale for long. Before client navigation,
 * back was a full reload and always fresh; this keeps that promise.
 */
export function RefreshOnBack() {
  const router = useRouter();
  useEffect(() => {
    const onPop = () => {
      // After the router has restored the page.
      setTimeout(() => startTransition(() => router.refresh()), 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [router]);
  return null;
}
