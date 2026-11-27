import { AppLink } from "@/components/ui/AppLink";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { navLinkClass, SiteHeader } from "@/components/ui/SiteHeader";

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
  const t = useTranslations("common");
  return (
    <>
      <SiteHeader
        nav={
          signedIn ? (
            <AppLink className={navLinkClass} href="/orgs">
              {t("orgs")}
            </AppLink>
          ) : noLoginLink ? null : (
            <a className={navLinkClass} href="/login">
              {t("signIn")}
            </a>
          )
        }
      />
      <main id="innehall" className={flush ? "flex-1" : "flex-1 pt-8 pb-16"}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
