"use client";

import { usePathname } from "next/navigation";
import { AppLink } from "@/components/ui/AppLink";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { navLinkClass as baseLinkClass } from "@/components/ui/SiteHeader";

// Four links fit a 390px phone next to the wordmark only with less padding.
const navLinkClass = `${baseLinkClass} max-[30rem]:px-2`;

/**
 * Top-rail links for the logged-in area (Hem = Mina uppgifter, the page after sign-in). Client only for aria-current. On phones the email
 * and Logga ut drop out (Logga ut is also on the Konto page), so the rail never scrolls sideways.
 */
export function AppNav({ email, signOut }: { email: string; signOut: FormAction }) {
  const t = useTranslations("common");
  const path = usePathname() ?? "";
  const current = (prefix: string) => (path === prefix || path.startsWith(`${prefix}/`) ? "page" : undefined);
  return (
    <>
      <AppLink className={navLinkClass} href="/hem" aria-current={current("/hem")}>
        {t("home")}
      </AppLink>
      <AppLink className={navLinkClass} href="/privat" aria-current={current("/privat")}>
        {t("privat")}
      </AppLink>
      <AppLink className={navLinkClass} href="/orgs" aria-current={current("/orgs")}>
        {t("orgs")}
      </AppLink>
      <AppLink className={navLinkClass} href="/installningar" aria-current={current("/installningar")}>
        {t("account")}
      </AppLink>
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
