"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * The landing header's frame: opaque and borderless at the top of the page; once the page has
 * scrolled, a hairline appears and what passes under it is blurred (the colour stays 92 % board,
 * so text under it never reads as low contrast).
 */
export function HeaderFrame({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > 8);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);
  return (
    <header
      data-scrolled={scrolled}
      style={{ viewTransitionName: "site-header" }}
      className="sticky top-0 z-30 border-b border-transparent bg-board transition-[background-color,border-color,backdrop-filter] duration-200 ease-out data-[scrolled=true]:border-line data-[scrolled=true]:bg-board/[0.92] data-[scrolled=true]:backdrop-blur-xl data-[scrolled=true]:backdrop-saturate-150"
    >
      {children}
    </header>
  );
}
