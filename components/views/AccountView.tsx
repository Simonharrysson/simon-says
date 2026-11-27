import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { EmailPrefs } from "@/lib/email/categories";
import { EmailPrefsForm, type SaveEmailPrefs } from "./EmailPrefsForm";
import { LanguageSelect } from "./LanguageSelect";

export function AccountView({
  email,
  signOut,
  emailPrefs,
  saveEmailPrefs,
  saveLocale,
  localeFailed,
  calendar,
}: {
  email: string;
  signOut: FormAction;
  /** null: the choices could not be loaded (the panel says so instead of guessing). */
  emailPrefs: EmailPrefs | null;
  saveEmailPrefs: SaveEmailPrefs;
  /** Saves the language (form field `locale`): the account's row and the `lang` cookie. */
  saveLocale: FormAction;
  /** The last save reached the cookie but not the account (`?fel=sprak`). */
  localeFailed?: boolean;
  /** "Kalender" (todo #14): connect or disconnect the Google Calendar (CalendarConnect). */
  calendar?: ReactNode;
}) {
  const t = useTranslations("account");
  const common = useTranslations("common");
  const calT = useTranslations("calendar");
  const locale = useLocale();
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col gap-6">
      <PageHeader title={t("title")} />
      <Panel title={t("signedInAs")} titleId="account-title">
        <dl className="flex flex-col gap-4 [&_dd]:mt-1 [&_dd]:flex [&_dd]:flex-col [&_dd]:gap-1 [&_dd]:wrap-anywhere [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:text-ink-3">
          <div>
            <dt>{t("googleAccount")}</dt>
            <dd>{email}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title={t("languageTitle")} titleId="language-title">
        <form action={saveLocale} className="flex flex-col gap-4">
          <p className="text-ink-2 max-w-[68ch]">{t("languageIntro")}</p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-locale">{t("languageLabel")}</Label>
            <LanguageSelect id="account-locale" defaultValue={locale} savingLabel={t("languageSaving")} />
          </div>
          {localeFailed && (
            <Banner tone="warning" live={false}>
              {t("languageSaveFailed")}
            </Banner>
          )}
        </form>
      </Panel>
      <Panel title={t("mailTitle")} titleId="mail-title">
        <div className="flex flex-col gap-4">
          <p className="text-ink-2 max-w-[68ch]">{t("mailIntro")}</p>
          {emailPrefs ? (
            <EmailPrefsForm initial={emailPrefs} save={saveEmailPrefs} idPrefix="account-mail" />
          ) : (
            <Banner tone="warning" title={t("mailLoadErrorTitle")}>
              {t("mailLoadErrorText")}
            </Banner>
          )}
        </div>
      </Panel>
      {calendar && (
        <Panel title={calT("connectTitle")} titleId="calendar-title" id="kalender">
          {calendar}
        </Panel>
      )}
      <Panel title={t("orgsTitle")} titleId="orgs-link-title">
        <div className="flex flex-col gap-4">
          <p className="text-ink-2">{t("orgsText")}</p>
          <div>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              {t("orgsLink")}
            </ButtonLink>
          </div>
        </div>
      </Panel>
      <Panel title={t("privacyTitle")} titleId="privacy-title">
        <p className="text-ink-2 max-w-[68ch]">
          {t.rich("privacyText", { link: (chunks) => <a href="/integritet">{chunks}</a> })}
        </p>
      </Panel>
      <form action={signOut}>
        <SubmitButton pendingLabel={common("signingOut")}>{common("signOut")}</SubmitButton>
      </form>
    </div>
  );
}
