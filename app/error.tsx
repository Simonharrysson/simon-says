"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { IconRefresh } from "@/components/ui/icons";

/** Catches errors thrown while rendering a page (e.g. a database read failing). */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("common");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="innehall" className="flex-1 pt-8 pb-16">
      <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col items-start gap-4 py-[clamp(2rem,8vh,6rem)]">
        <p className="font-mono text-sm text-ink-3">{t("errorCode")}{error.digest ? ` · ${error.digest}` : ""}</p>
        <h1 className="text-2xl">{t("errorTitle")}</h1>
        <p className="text-ink-2">
          {t("errorText")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={<IconRefresh />} onClick={() => retry()}>
            {t("tryAgain")}
          </Button>
          <ButtonLink href="/" variant="ghost">
            {t("toHome")}
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
