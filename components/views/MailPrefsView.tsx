import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import type { EmailCategory, EmailPrefs } from "@/lib/email/categories";
import { EmailPrefsForm, type SaveEmailPrefs } from "./EmailPrefsForm";

export type MailPrefsViewProps =
  | { state: "ready"; email: string; prefs: EmailPrefs; save: SaveEmailPrefs; highlight?: EmailCategory }
  | { state: "invalid" }
  | { state: "error" };

/**
 * /mejl: the link at the bottom of every mail. No login: the signed link names the address, and
 * only that address's choices can be changed here. Opening the page changes nothing.
 */
export function MailPrefsView(props: MailPrefsViewProps) {
  const t = useTranslations("mailPrefs");
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div data-card className="w-full max-w-[34rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        {props.state === "ready" && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl">{t("title")}</h1>
              <p className="text-ink-2">
                {t.rich("chooseFor", {
                  email: props.email,
                  strong: (chunks) => <strong className="font-medium text-ink wrap-anywhere">{chunks}</strong>,
                })}
                {props.highlight ? t("highlight", { category: t(`categories.${props.highlight}.label`).toLowerCase() }) : ""}{" "}
                {t("appliesAtOnce")}
              </p>
            </div>
            <EmailPrefsForm initial={props.prefs} save={props.save} idPrefix="link-mail" highlight={props.highlight} />
            <p className="text-sm text-ink-3">
              {t.rich("accountHint", { link: (chunks) => <a href="/integritet#mejl">{chunks}</a> })}
            </p>
          </>
        )}
        {props.state === "invalid" && (
          <>
            <h1 className="text-2xl">{t("invalidTitle")}</h1>
            <Banner tone="danger" title={t("invalidBannerTitle")}>
              {t("invalidBannerText")}
            </Banner>
          </>
        )}
        {props.state === "error" && (
          <>
            <h1 className="text-2xl">{t("title")}</h1>
            <Banner tone="warning" title={t("errorBannerTitle")}>
              {t("errorBannerText")}
            </Banner>
          </>
        )}
      </div>
    </div>
  );
}
