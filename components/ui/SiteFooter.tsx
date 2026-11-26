import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { LanguageSwitch } from "./LanguageSwitch";

const REPO = "https://github.com/Simonharrysson/simon-says";

export function SiteFooter() {
  const t = useTranslations("common");
  return (
    <footer className="border-t border-line py-8 text-sm text-ink-3 [&_a]:text-ink-2">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-3 px-gutter">
        <p>{t("footerTagline")}</p>
        <nav aria-label={t("footerNav")} className="flex flex-wrap items-center gap-5">
          <a href="/status">{t("status")}</a>
          <a href="/integritet">{t("privacy")}</a>
          <a href={REPO} rel="noopener">
            {t("sourceCode")}
          </a>
          <Suspense>
            <LanguageSwitch />
          </Suspense>
        </nav>
      </div>
    </footer>
  );
}
