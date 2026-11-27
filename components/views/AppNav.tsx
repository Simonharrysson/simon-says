"use client";

import { usePathname } from "next/navigation";
import { AppLink } from "@/components/ui/AppLink";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconUser } from "@/components/ui/icons";
import { navLinkClass as baseLinkClass } from "@/components/ui/SiteHeader";
import { navSection, type NavSection } from "@/lib/nav/section";

// Four links fit a 390px phone next to the wordmark only with less padding. With Företag (five)
// the rail takes its own row on a phone (SiteHeader `wideNav`) and Konto shrinks to an icon.
const navLinkClass = `${baseLinkClass} max-[30rem]:px-2`;
const wideLinkClass = `${baseLinkClass} max-[30rem]:px-1.5`;

const SECTIONS: { href: NavSection; key: "home" | "privat" | "orgs" | "foretag" | "account" }[] = [
  { href: "/hem", key: "home" },
  { href: "/privat", key: "privat" },
  { href: "/orgs", key: "orgs" },
  { href: "/foretag", key: "foretag" },
  { href: "/installningar", key: "account" },
];

/**
 * Top-rail links for the logged-in area (Hem = Mina uppgifter, the page after sign-in). Client only for aria-current. On phones the email
 * and Logga ut drop out (Logga ut is also on the Konto page), so the rail never scrolls sideways.
 * Företag shows only to members of a company or those who may create one (`companyIds`,
 * `showForetag` from the layout); a company's /orgs/<id> pages mark Företag, not Föreningar.
 */
export function AppNav({ email, signOut, showForetag = false, companyIds = [] }: { email: string; signOut: FormAction; showForetag?: boolean; companyIds?: string[] }) {
  const t = useTranslations("common");
  const path = usePathname() ?? "";
  const current = navSection(path, companyIds);
  const linkClass = showForetag ? wideLinkClass : navLinkClass;
  return (
    <>
      {SECTIONS.filter((s) => showForetag || s.href !== "/foretag").map((s) => (
        <AppLink key={s.href} className={linkClass} href={s.href} aria-current={current === s.href ? "page" : undefined}>
          {showForetag && s.key === "account" ? (
            <>
              <IconUser className="hidden max-[30rem]:block" />
              <span className="max-[30rem]:sr-only">{t(s.key)}</span>
            </>
          ) : (
            t(s.key)
          )}
        </AppLink>
      ))}
      {email && (
        <span className="max-w-[14rem] truncate text-xs text-ink-3 max-md:hidden" title={email}>
          {email}
        </span>
      )}
      <form action={signOut} className="max-[30rem]:hidden">
        <SubmitButton variant="ghost" size="sm" pendingLabel={t("signingOut")}>
          {t("signOut")}
        </SubmitButton>
      </form>
    </>
  );
}
