import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { EmailPrefs } from "@/lib/email/categories";
import type { SectionId } from "@/lib/account/sections";
import { mailSummary } from "@/lib/account/summary";
import { AccountSection, AccountSections, SummaryStatus } from "./AccountSection";
import { EmailPrefsForm, type BriefForeningarPref, type SaveEmailPrefs } from "./EmailPrefsForm";
import { LanguageSelect } from "./LanguageSelect";

const LANGUAGE_NAMES: Record<string, string> = { sv: "Svenska", en: "English" };

/**
 * Konto (/installningar): one collapsible section per subject (components/views/AccountSection.tsx),
 * all closed until the user opens one, each saying its state in its header while closed.
 */
export function AccountView({
  userId = "",
  email,
  signOut,
  emailPrefs,
  saveEmailPrefs,
  briefForeningar,
  saveLocale,
  localeFailed,
  calendar,
  ai,
  openSections = [],
}: {
  /** Whose remembered open sections to use (localStorage is per account). */
  userId?: string;
  email: string;
  signOut: FormAction;
  /** null: the choices could not be loaded (the panel says so instead of guessing). */
  emailPrefs: EmailPrefs | null;
  saveEmailPrefs: SaveEmailPrefs;
  /** Inför möten for föreningar (opt-in, 0059); absent: not offered. */
  briefForeningar?: BriefForeningarPref;
  /** Saves the language (form field `locale`): the account's row and the `lang` cookie. */
  saveLocale: FormAction;
  /** The last save reached the cookie but not the account (`?fel=sprak`). */
  localeFailed?: boolean;
  /** "Kalender" (todo #14): connect or disconnect the Google Calendar (CalendarConnect), and its state for the summary. */
  calendar?: { node: ReactNode; connected: boolean };
  /** "Koppla till din AI" (the MCP server, components/views/AiConnections.tsx), and how many are connected. */
  ai?: { node: ReactNode; connected: number };
  /** Sections the server opens: one with a result to show (?kalender=…, ?fel=…). */
  openSections?: SectionId[];
}) {
  const t = useTranslations("account");
  const common = useTranslations("common");
  const calT = useTranslations("calendar");
  const connectT = useTranslations("connect");
  const locale = useLocale();
  const forced: SectionId[] = [...openSections, ...(localeFailed ? (["sprak"] as const) : [])];
  const mail = emailPrefs ? mailSummary(emailPrefs, briefForeningar?.initial) : null;
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col gap-6">
      <PageHeader title={t("title")} />
      <AccountSections userId={userId} forced={forced}>
        <div className="flex flex-col gap-3">
          <AccountSection id="konto" title={t("signedInAs")} summary={<span className="truncate">{email}</span>}>
            <dl className="flex flex-col gap-4 [&_dd]:mt-1 [&_dd]:flex [&_dd]:flex-col [&_dd]:gap-1 [&_dd]:wrap-anywhere [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:text-ink-3">
              <div>
                <dt>{t("googleAccount")}</dt>
                <dd>{email}</dd>
              </div>
            </dl>
          </AccountSection>
          <AccountSection id="sprak" title={t("languageTitle")} summary={LANGUAGE_NAMES[locale] ?? locale}>
            <form action={saveLocale} className="flex flex-col gap-4">
              <p className="text-ink-2 max-w-[68ch]">{t("languageIntro")}</p>
              <div className="flex flex-col gap-2">
                <span id="account-locale" className="text-sm font-medium">
                  {t("languageLabel")}
                </span>
                <LanguageSelect labelId="account-locale" current={locale} savingLabel={t("languageSaving")} />
              </div>
              {localeFailed && (
                <Banner tone="warning" live={false}>
                  {t("languageSaveFailed")}
                </Banner>
              )}
            </form>
          </AccountSection>
          <AccountSection
            id="mejl"
            title={t("mailTitle")}
            summary={
              mail ? (
                <SummaryStatus on={mail.on > 0}>{mail.on === 0 ? t("summaryMailAllOff") : t("summaryMailOn", { on: mail.on, total: mail.total })}</SummaryStatus>
              ) : (
                t("summaryMailError")
              )
            }
          >
            <div className="flex flex-col gap-4">
              <p className="text-ink-2 max-w-[68ch]">{t("mailIntro")}</p>
              {emailPrefs ? (
                <EmailPrefsForm initial={emailPrefs} save={saveEmailPrefs} idPrefix="account-mail" briefForeningar={briefForeningar} />
              ) : (
                <Banner tone="warning" title={t("mailLoadErrorTitle")}>
                  {t("mailLoadErrorText")}
                </Banner>
              )}
            </div>
          </AccountSection>
          {calendar && (
            <AccountSection
              id="kalender"
              title={calT("connectTitle")}
              summary={<SummaryStatus on={calendar.connected}>{calendar.connected ? t("summaryConnected") : t("summaryNotConnected")}</SummaryStatus>}
            >
              {calendar.node}
            </AccountSection>
          )}
          {ai && (
            <AccountSection
              id="ai"
              title={connectT("panelTitle")}
              summary={
                <SummaryStatus on={ai.connected > 0}>
                  {ai.connected > 0 ? t("summaryAiConnected", { count: ai.connected }) : t("summaryNotConnected")}
                </SummaryStatus>
              }
            >
              {ai.node}
            </AccountSection>
          )}
          <AccountSection id="foreningar" title={t("orgsTitle")} summary={t("summaryOrgs")}>
            <div className="flex flex-col gap-4">
              <p className="text-ink-2">{t("orgsText")}</p>
              <div>
                <ButtonLink href="/orgs" icon={<IconArrowRight />}>
                  {t("orgsLink")}
                </ButtonLink>
              </div>
            </div>
          </AccountSection>
          <AccountSection id="integritet" title={t("privacyTitle")} summary={t("summaryPrivacy")}>
            <p className="text-ink-2 max-w-[68ch]">
              {t.rich("privacyText", { link: (chunks) => <a href="/integritet">{chunks}</a> })}
            </p>
          </AccountSection>
        </div>
      </AccountSections>
      <form action={signOut}>
        <SubmitButton pendingLabel={common("signingOut")}>{common("signOut")}</SubmitButton>
      </form>
    </div>
  );
}
