import { useTranslations } from "next-intl";
import { ButtonLink } from "@/components/ui/button";
import { IconArrowLeft } from "@/components/ui/icons";
import { PublicShell } from "@/components/views/PublicShell";

export default function NotFound() {
  const t = useTranslations("common");
  return (
    <PublicShell signedIn={false}>
      <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col items-start gap-4 py-[clamp(2rem,8vh,6rem)]">
        <p className="font-mono text-sm text-ink-3">404</p>
        <h1 className="text-2xl">{t("notFoundTitle")}</h1>
        <p className="text-ink-2">
          {t("notFoundText")}
        </p>
        <ButtonLink href="/" icon={<IconArrowLeft />}>
          {t("toHome")}
        </ButtonLink>
      </div>
    </PublicShell>
  );
}
