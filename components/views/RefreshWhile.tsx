"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

/**
 * Re-reads the page every `ms` while mounted (in the background, keeping what shows): the Nästa
 * möte card while a meeting's notes are being finished, so it turns into the recap by itself.
 */
export function RefreshWhile({ ms = 5000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, ms);
    return () => clearInterval(t);
  }, [ms, router]);
  return null;
}
