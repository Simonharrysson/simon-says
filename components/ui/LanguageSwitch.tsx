"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

/**
 * "English" / "Svenska" in the footer: a plain link to /sprak, which sets the `lang` cookie (and
 * the account's saved choice when signed in) and comes back here. Works without JavaScript.
 */
export function LanguageSwitch() {
  const t = useTranslations("common");
  const locale = useLocale();
  const path = usePathname() ?? "/";
  const query = useSearchParams()?.toString();
  const back = query ? `${path}?${query}` : path;
  const to = locale === "en" ? "sv" : "en";
  return (
    <a href={`/sprak?till=${to}&tillbaka=${encodeURIComponent(back)}`} hrefLang={to} lang={to}>
      {t("switchLanguage")}
    </a>
  );
}
