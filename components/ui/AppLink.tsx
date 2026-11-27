"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, Ref } from "react";
import { isClientRoute } from "@/lib/ui/links";

/** The view-transition type of a link navigation (app/(app)/layout.tsx). */
const NAV = ["nav"];

export type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
  /**
   * When to warm the route: "viewport" (the top rail: few links, nearly always used) or
   * "intent" (default: on hover, focus or touch, so a long list never floods the server).
   */
  prefetch?: "viewport" | "intent";
};

/**
 * An in-app link. App routes navigate client-side with next/link (no blank page: the header
 * stays and the route's skeleton shows at once); everything else (lib/ui/links.ts: the live
 * page, route handlers, other sites, new tabs, downloads) is a plain <a>.
 */
export function AppLink({ href, prefetch = "intent", onMouseEnter, onFocus, onTouchStart, ...rest }: AppLinkProps) {
  const router = useRouter();
  if (!isClientRoute(href) || rest.target || rest.download !== undefined) {
    return <a href={href} onMouseEnter={onMouseEnter} onFocus={onFocus} onTouchStart={onTouchStart} {...rest} />;
  }
  if (prefetch === "viewport") return <Link href={href} transitionTypes={NAV} onMouseEnter={onMouseEnter} onFocus={onFocus} onTouchStart={onTouchStart} {...rest} />;
  const warm = () => router.prefetch(href);
  return (
    <Link
      href={href}
      prefetch={false}
      transitionTypes={NAV}
      onMouseEnter={(e) => {
        warm();
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        warm();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        warm();
        onTouchStart?.(e);
      }}
      {...rest}
    />
  );
}
