import type { ReactNode } from "react";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { SiteHeader } from "@/components/ui/SiteHeader";

/** Header + main + footer for pages outside the logged-in area. */
/** `noLoginLink` hides the header's "Logga in" (on /login itself). */
export function PublicShell({
  signedIn,
  children,
  flush,
  noLoginLink,
}: {
  signedIn: boolean;
  children: ReactNode;
  flush?: boolean;
  noLoginLink?: boolean;
}) {
  return (
    <>
      <SiteHeader
        nav={
          signedIn ? (
            <a className="nav-link" href="/orgs">
              Föreningar
            </a>
          ) : noLoginLink ? null : (
            <a className="nav-link" href="/login">
              Logga in
            </a>
          )
        }
      />
      <main id="innehall" className={flush ? undefined : "main"} style={flush ? { flex: 1 } : undefined}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
