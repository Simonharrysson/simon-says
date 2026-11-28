import { useLocale, useTranslations } from "next-intl";
import { AdminWeeks } from "@/components/admin/AdminWeeks";
import { OrgTable } from "@/components/admin/OrgTable";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import type { AdminOrgRow, AdminOverview } from "@/lib/admin/stats";
import { formatClock } from "@/lib/format";
import { intlTag, toLocale } from "@/lib/i18n/config";

/** Insikter (/admin): key figures, a health line, 12 weeks of meetings and sign-ups, every org. */
export function AdminView({ overview: o, orgs, updatedAt }: { overview: AdminOverview; orgs: AdminOrgRow[]; updatedAt: string }) {
  const t = useTranslations("admin");
  const locale = toLocale(useLocale());
  const num = new Intl.NumberFormat(intlTag(locale));
  const orgTotal = o.orgs.forening + o.orgs.foretag + o.orgs.privat;
  const failures = [
    o.health.summaries && t("healthSummaries", { count: o.health.summaries }),
    o.health.summaryMails && t("healthSummaryMails", { count: o.health.summaryMails }),
    o.health.briefs && t("healthBriefs", { count: o.health.briefs }),
    o.health.invites && t("healthInvites", { count: o.health.invites }),
  ].filter((x): x is string => Boolean(x));

  const kpis: { label: string; value: string; note: string }[] = [
    { label: t("users"), value: num.format(o.users), note: t("usersNote") },
    { label: t("active7"), value: num.format(o.active7), note: t("activeNote") },
    { label: t("active30"), value: num.format(o.active30), note: t("activeNote") },
    { label: t("orgs"), value: num.format(orgTotal), note: t("orgsNote", o.orgs) },
    { label: t("meetings"), value: num.format(o.meetings), note: t("meetingsNote", { count: num.format(o.meetings7) }) },
    { label: t("minutes"), value: t("minutesValue", { count: num.format(o.minutes30) }), note: t("minutesNote", { hours: num.format(Math.round(o.minutes30 / 6) / 10) }) },
  ];

  return (
    <div className="mx-auto flex w-full max-w-page flex-col gap-8 px-gutter">
      <div>
        <PageHeader title={t("title")} meta={<p className="max-w-[68ch] text-ink-2">{t("intro")}</p>} />
        <section aria-label={t("kpis")} className="-mt-2">
          {/* Hairline tiles on the board, as on /status: no card around a card. */}
          <dl className="grid grid-cols-3 gap-x-6 gap-y-6 max-[52rem]:grid-cols-2">
            {kpis.map((k) => (
              <div key={k.label} data-enter-item className="flex min-w-0 flex-col border-t border-line pt-4">
                <dt className="text-sm text-ink-2">{k.label}</dt>
                <dd className="mt-1 text-2xl font-semibold tracking-[-0.03em] max-[30rem]:text-xl">{k.value}</dd>
                <dd className="mt-1 text-sm text-ink-3">{k.note}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" role="status">
            <span className="text-ink-2">{t("healthLabel")}</span>
            {failures.length === 0 ? (
              <Badge tone="success">{t("healthOk")}</Badge>
            ) : (
              failures.map((f) => (
                <Badge key={f} tone="alert">
                  {f}
                </Badge>
              ))
            )}
          </p>
        </section>
      </div>

      <Panel title={t("weeksTitle")} titleId="admin-weeks">
        <p className="-mt-2 mb-5 text-sm text-ink-3">{t("weeksIntro")}</p>
        <AdminWeeks weeks={o.weeks} />
      </Panel>

      <Panel title={t("orgsTitle")} titleId="admin-orgs" flush>
        <OrgTable rows={orgs} />
      </Panel>

      <details className="group text-sm text-ink-3">
        <summary className="w-fit cursor-pointer text-ink-2 hover:text-ink">{t("definitions")}</summary>
        <p className="mt-2 max-w-[72ch]">{t("definitionsText")}</p>
      </details>
      <p className="-mt-4 text-sm text-ink-3">{t("updated", { time: formatClock(updatedAt, locale) })}</p>
    </div>
  );
}

