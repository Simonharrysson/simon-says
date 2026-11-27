"use client";

import { useEffect, useState } from "react";
import { useMountedFresh } from "./fresh";

/**
 * A progress bar's fill. Revealed with clip-path (the rounded end stays round at any width,
 * unlike scaleX), so changes glide; it grows from empty only when it mounts in a client render,
 * never on a page load. Reduced motion: the global rule makes it instant.
 */
export function ProgressFill({ pct, className }: { pct: number; className?: string }) {
  const fresh = useMountedFresh();
  const [shown, setShown] = useState(fresh ? 0 : pct);
  useEffect(() => {
    // One frame at 0 first, so a fresh mount has something to grow from.
    const id = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  const clamped = Math.max(0, Math.min(100, shown));
  return (
    <div
      className={className}
      style={{ clipPath: `inset(0 ${100 - clamped}% 0 0 round 9999px)`, transition: "clip-path 600ms var(--ease-out)" }}
    />
  );
}
