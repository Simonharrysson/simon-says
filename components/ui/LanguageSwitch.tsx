"use client";

import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

/**
 * "English" / "Svenska" in the footer: a plain link to /sprak, which sets the `lang` cookie (and
 * the account's saved choice when signed in) and comes back here. Works without JavaScript.
 */
export function LanguageSwitch() {
  const t = useTranslations("common");
  const locale = useLocale();
  // The path only (no useSearchParams, which would force a Suspense boundary on static routes);
  // the query is added from the address bar on click.
  const back = usePathname() ?? "/";
  const to = locale === "en" ? "sv" : "en";
  return (
    <a
      href={`/sprak?till=${to}&tillbaka=${encodeURIComponent(back)}`}
      hrefLang={to}
      lang={to}
      onClick={(e) => {
        const here = window.location.pathname + window.location.search;
        e.currentTarget.href = `/sprak?till=${to}&tillbaka=${encodeURIComponent(here)}`;
      }}
    >
      {t("switchLanguage")}
    </a>
  );
}
