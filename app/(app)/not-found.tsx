import { useTranslations } from "next-intl";
import { ButtonLink } from "@/components/ui/button";
import { IconArrowLeft } from "@/components/ui/icons";

// A notFound() inside the signed-in area renders inside app/(app)/layout.tsx, which already has
// the header, <main> and footer: only the message here (the root not-found's PublicShell would
// add a second header with "Logga in" and a nested <main>).
export default function SignedInNotFound() {
  const t = useTranslations("common");
  const orgs = useTranslations("orgs");
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col items-start gap-4 py-[clamp(2rem,8vh,6rem)]">
      <p className="font-mono text-sm text-ink-3">404</p>
      <h1 className="text-2xl">{t("notFoundTitle")}</h1>
      <p className="text-ink-2">{t("notFoundText")}</p>
      <ButtonLink href="/orgs" icon={<IconArrowLeft />}>
        {orgs("toYours")}
      </ButtonLink>
    </div>
  );
}
