import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconArrowRight } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NoticeBanner } from "@/components/views/NoticeBanner";
import type { CustomerRow } from "@/lib/db/foretag";
import type { ForetagMeeting } from "@/lib/foretag/page";
import type { GroupRow } from "@/lib/foretag/tree";
import { formatDateTime } from "@/lib/format";
import type { Locale } from "@/lib/i18n/config";
import type { Notice } from "@/lib/ui/messages";

// A Företag customer page (0050): the meetings with the customer that the viewer may see (RLS),
// and their open tasks. No outside data: everything comes from the company's own meetings.

export function CustomerView({
  orgId,
  customer,
  meetings,
  openTasks,
  groups,
  notice,
  rename,
}: {
  orgId: string;
  customer: CustomerRow;
  meetings: ForetagMeeting[];
  openTasks: { meeting_id: string; id: string; text: string; owner: string | null; due: string | null }[];
  groups: GroupRow[];
  notice: Notice | null;
  rename: FormAction;
}) {
  const t = useTranslations("foretag.customers");
  const tm = useTranslations("foretag.meetings");
  const locale = useLocale() as Locale;
  const started = new Map(meetings.map((m) => [m.id, m.started_at]));
  const group = (id: string | null) => (id ? (groups.find((g) => g.id === id)?.name ?? tm("whole")) : tm("whole"));
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-gutter">
      <PageHeader title={customer.name} back={{ href: `/orgs/${orgId}?flik=kunder`, label: t("back") }} meta={<p className="text-sm text-ink-3">{t("domain", { domain: customer.domain })}</p>} />
      <NoticeBanner notice={notice} />

      <Panel flush title={t("tasksTitle")} titleId="tasks-title">
        {openTasks.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-ink-3">{t("noTasks")}</p>
        ) : (
          <ul aria-labelledby="tasks-title">
            {openTasks.map((r) => (
              <ListRow
                key={`${r.meeting_id}:${r.id}`}
                href={`/orgs/${orgId}/mote/${r.meeting_id}`}
                title={r.text}
                meta={
                  <>
                    {[r.owner, r.due ? t("due", { due: r.due }) : null].filter(Boolean).join(" · ")}
                    {(r.owner || r.due) && " · "}
                    {t("fromMeeting", { day: formatDateTime(started.get(r.meeting_id) ?? "", locale) })}
                  </>
                }
              />
            ))}
          </ul>
        )}
      </Panel>

      {meetings.length === 0 ? (
        <EmptyState title={t("meetingsTitle")}>
          <p>{t("noMeetings")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("meetingsTitle")} titleId="cmeetings-title">
          <ul aria-labelledby="cmeetings-title">
            {meetings.map((m) => {
              const running = m.status === "live" || m.status === "ending";
              return (
                <ListRow
                  key={m.id}
                  href={running ? `/meetings/${m.id}` : `/orgs/${orgId}/mote/${m.id}`}
                  title={formatDateTime(m.started_at, locale)}
                  meta={<span className="font-medium text-ink-2">{group(m.group_id)}</span>}
                  actions={
                    <>
                      {m.private && <Badge>{tm("private")}</Badge>}
                      {running && <Badge tone="live">{tm("live")}</Badge>}
                      <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                    </>
                  }
                />
              );
            })}
          </ul>
        </Panel>
      )}

      <Panel title={t("rename")} titleId="rename-title">
        <form action={rename} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="customerId" value={customer.id} />
          <Field id="customer-name" name="name" label={t("renameLabel")} defaultValue={customer.name} required maxLength={80} className="min-w-[14rem] flex-1" />
          <SubmitButton variant="secondary" pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </form>
      </Panel>
    </div>
  );
}
