"use client";

import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";

/**
 * Admins, on the förening's pages: Google no longer accepts the förening's Drive account (0070).
 * Nothing is written to any other Drive meanwhile; "Förnya" leads to the folder card.
 */
export function DriveAccountLostBanner({ email, href }: { email: string; href: string }) {
  const t = useTranslations("onboarding.folder.account");
  return (
    <Banner
      tone="warning"
      title={t("lostTitle")}
      action={
        <ButtonLink href={href} variant="secondary" size="sm">
          {t("renew")}
        </ButtonLink>
      }
    >
      {t("lostText", { email })}
    </Banner>
  );
}
